# Krmx Hub — Architecture & Build Plan

> This document is the project constitution. It captures every design decision
> made so far. Implementation sessions (human or AI) must conform to it; if a
> change is needed, change this document first, then the code.

## 1. Vision

A hub for Simon's Krmx-based multiplayer games. The hub owns **identity,
approval, roles, credits, and the game/instance registry**. Games run
**independently** — their servers and frontends are built, versioned, and
deployed outside the hub. The hub embeds game frontends in a sandboxed iframe
and brokers authentication to game servers via short-lived tickets.

Close-to-Krmx is fine (all first-party games use Krmx), but the platform
contract is transport-agnostic: nothing in the hub assumes Krmx.

## 2. Actors & roles

- **anonymous** — not signed in. Can browse the public catalog (games, hosts,
  live instance counts). Cannot play.
- **user** — signed in *and* admin-approved. Has a credit balance. Can create,
  join, and play instances.
- **host** (additional role) — can register games, versions, and a provision
  endpoint; runs game servers and frontends.
- **admin** (additional role) — approves/blocks users, grants roles, grants
  credits, suspends games.

Roles are additive flags on the participant (`roles TEXT[]`). Everyone is
anonymous or a user; a user may also be host and/or admin. Pending
(not-yet-approved) users are effectively anonymous plus a waiting screen.
Initial admin: `mail@simonkarman.nl` via `ADMIN_EMAIL` env bootstrap.

## 3. Components

```
┌─────────────────────────── hub.example ───────────────────────────┐
│  Hub (one Next.js deploy: static frontend + serverless API)       │
│  • Auth.js v5 (Google / Apple / email magic link)                 │
│  • approval gate, roles, admin dashboard                          │
│  • game & version registry, instance lifecycle                    │
│  • credit ledger (append-only)                                    │
│  • ticket minting (RS256) + /.well-known/jwks.json                │
│  • service API (heartbeat / state / results)                      │
│  • <PlayFrame> iframe shell + postMessage broker                  │
└──────────────┬────────────────────────────────────┬───────────────┘
               │                                    │
        Neon Postgres                     Host-operated, per game:
        (pooled, source of truth)         • provision endpoint (serverless)
                                          • game frontend (static, versioned,
                                            stable origin, e.g. CDN)
                                          • game servers (Cloud Run,
                                            service-per-instance, scale-to-0)
```

## 4. The three credentials

| Credential | Between | Form | Lifetime | Scope |
|---|---|---|---|---|
| Session | browser ↔ hub | Auth.js DB session cookie | weeks | the user |
| Player ticket | user → game server | **RS256 JWT** minted by hub | **2 minutes** | one instance (`aud`) |
| Service token | game server → hub | opaque 256-bit random, stored **hashed** | instance lifetime, revocable | one instance |

Player ticket claims:

```json
{
  "iss": "https://hub.example",
  "sub": "<participant email>",
  "aud": "instance:<instanceId>",
  "name": "<krmx username>",
  "jti": "<random single-use id>",
  "iat": 0, "exp": 0
}
```

- Hub signs with a private key (env/KMS). Public keys served at
  `/.well-known/jwks.json` with `kid`, enabling rotation.
- Game servers verify **offline** via cached JWKS and MUST check `aud`
  against their own instance id. Short TTL + live status check at minting
  substitutes for revocation.
- **Tickets are single-use**: verifiers keep a seen-`jti` set (TTL = ticket
  lifetime) and reject reuse. Legit reconnects always fetch a fresh ticket
  via `hub:request-ticket`, so this costs nothing.
- Every `jwtVerify` call passes an explicit `{ algorithms: ['RS256'] }`
  allowlist — never derive the algorithm from the token header.
- The ticket endpoint and sign-in are **rate limited** (per session / per IP).
- Service token: `Authorization: Bearer <token>` on service API calls; hub
  compares against `sha256` hash on the instance row. Revoked at settlement,
  cancellation, or reaping.

**HS256 is forbidden** for tickets: hosts are semi-trusted, and with a shared
secret every verifier is also a minter.

## 5. Data model (Postgres)

```sql
-- Auth.js adapter tables (users, accounts, sessions, verification_token)
-- are managed by @auth/pg-adapter and omitted here.

CREATE TABLE participant (
  email        TEXT PRIMARY KEY,
  username     TEXT UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','blocked')),
  roles        TEXT[] NOT NULL DEFAULT '{}',   -- e.g. {host,admin}
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at   TIMESTAMPTZ,
  decided_by   TEXT
);

CREATE TABLE game (
  id             TEXT PRIMARY KEY,             -- slug, e.g. 'tictactoe'
  host_email     TEXT NOT NULL REFERENCES participant(email),
  name           TEXT NOT NULL,
  description    TEXT,
  status         TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','published','suspended')),
  webhook_secret TEXT NOT NULL,                -- HMAC key for provision calls
  entry_fee      INTEGER NOT NULL DEFAULT 0,   -- credits
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE game_version (
  id            SERIAL PRIMARY KEY,
  game_id       TEXT NOT NULL REFERENCES game(id),
  semver        TEXT NOT NULL,
  frontend_url  TEXT NOT NULL,   -- REGISTERED ahead of time; immutable
  provision_url TEXT NOT NULL,
  max_players   INTEGER NOT NULL DEFAULT 2   -- instance capacity (§6.2)
                  CHECK (max_players >= 1),
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','deprecated','revoked')),
  UNIQUE (game_id, semver)
);

CREATE TABLE instance (
  id                 TEXT PRIMARY KEY,          -- e.g. nanoid
  game_version_id    INTEGER NOT NULL REFERENCES game_version(id),
  created_by         TEXT NOT NULL REFERENCES participant(email),
  visibility         TEXT NOT NULL DEFAULT 'private'
                       CHECK (visibility IN ('private','public')),
  invite_code        TEXT UNIQUE,
  status             TEXT NOT NULL DEFAULT 'provisioning'
                       CHECK (status IN
                         ('provisioning','lobby','running','finished','cancelled')),
  server_url         TEXT,                      -- opaque; from provision response
  service_token_hash TEXT NOT NULL,
  last_heartbeat_at  TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at           TIMESTAMPTZ
);

CREATE TABLE instance_player (
  instance_id TEXT NOT NULL REFERENCES instance(id),
  email       TEXT NOT NULL REFERENCES participant(email),
  seat        INTEGER,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, email)
);

-- Append-only. Balance = SUM(amount). Only the hub writes rows.
CREATE TABLE ledger (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL REFERENCES participant(email),
  instance_id TEXT REFERENCES instance(id),
  type        TEXT NOT NULL CHECK (type IN
                ('grant','entry_hold','hold_release','payout')),
  amount      INTEGER NOT NULL,   -- entry_hold is negative
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Ledger invariants (test these):
- `balance(email) = SUM(amount)` and must never go negative from user actions.
- Every `entry_hold` is eventually paired with exactly one `hold_release`
  (cancel/reap) or contributes to a settlement (`payout` rows).
- Settlement of an instance conserves credits:
  `SUM(payouts) <= -SUM(entry_holds)` for that instance (difference = rake, 0 for now).

## 6. Flows

### 6.1 Provisioning (create instance)
1. User (approved, balance ≥ entry_fee) POSTs `/api/instances {gameId, versionId?, visibility}`.
2. Hub inserts instance (`provisioning`), generates service token, seats the
   creator (`instance_player`, seat 0) and writes their `entry_hold` — all in
   one transaction with the balance check.
3. Hub calls the version's `provision_url` with
   `{instanceId, serviceToken, hubUrl}` — request **HMAC-signed** with the
   game's `webhook_secret`: headers `x-hub-timestamp: <unix seconds>` and
   `x-hub-signature: sha256=<hmac(timestamp + "." + body)>`. Host endpoints
   MUST reject timestamps outside a ±60s window (replay protection).
4. Host endpoint starts a server (service-per-instance on Cloud Run;
   image pinned to a version tag, never `:latest`) and responds
   `{ "serverUrl": "wss://...", "version": "1.4.2"? }`.
   - `serverUrl` is **opaque** to the hub (could be wss, https, etc.).
   - Optional `version` may only *name a registered* version; the hub resolves
     `frontend_url` from its own registry. Provision responses can NEVER
     introduce new frontend URLs.
   - Synchronous with a 60s timeout for now; 202+callback is a future option.
5. Hub stores `server_url`, sets status `lobby`, returns invite code.

### 6.2 Join
`POST /api/instances/:id/join`: verify approved + capacity
(`< game_version.max_players`) + balance → `entry_hold` + `instance_player`
row, atomically. Idempotent: joining twice yields one hold and one row.

### 6.3 Play (ticket + iframe)
1. Hub play page renders `<PlayFrame>` with `src = registered frontend_url + "?instance=<id>"`
   (instance id is the only thing in the URL; it is non-secret).
2. Game iframe posts `{type:"hub:ready"}` to the hub origin.
3. Hub fetches `/api/instances/:id/ticket` (verifies membership + approved
   status), then posts `{type:"hub:init", ticket, serverUrl, instanceId, username, protocolVersion:1}`
   to the **registered origin only**.
4. Game frontend connects to `serverUrl` and authenticates with the ticket
   (for Krmx: `client.link(username, ticket)`).
5. On reconnect after ticket expiry, game posts `{type:"hub:request-ticket"}`;
   hub mints a fresh ticket using the still-valid session.

### 6.4 Heartbeat, state, results (service API)
- `POST /api/service/instances/:id/heartbeat` — every 60s; may include a state
  snapshot `{status: 'lobby'|'running', state?: json}` for hub-side lobby
  display. Hub is never authoritative for game state.
- `POST /api/service/instances/:id/results {ranking: [...]}` — hub verifies
  the service token belongs to `:id`, writes payouts, marks `finished`,
  revokes the token.
- **Reaper** (cron/scheduled function): instances in `provisioning|lobby|running`
  with `last_heartbeat_at` older than 3 intervals → `cancelled`, holds
  released, token revoked.

## 7. Frontend embedding contract (protocolVersion 1)

Game frontends are static, versioned, immutable, on a **stable origin**.
Hub CSP: `frame-src` = allowlist of registered frontend origins.
Iframe: `sandbox="allow-scripts allow-same-origin"` (safe because the frame is
cross-origin — it gets the host's origin, never the hub's).

Messages (all with pinned `targetOrigin`, both sides check `event.origin`):

```ts
// game -> hub
type GameToHub =
  | { type: 'hub:ready' }
  | { type: 'hub:request-ticket' }
  | { type: 'hub:exit' };           // user finished; hub navigates away

// hub -> game
type HubToGame =
  | { type: 'hub:init',
      protocolVersion: 1,
      instanceId: string,
      username: string,
      ticket: string,      // RS256 JWT, aud = instance:<id>
      serverUrl: string }; // opaque transport endpoint
```

Tickets NEVER appear in URLs (history/log/Referer leakage).

## 8. Packages (monorepo, pnpm workspaces + changesets)

```
apps/hub                    Next.js app (frontend + API routes)
packages/protocol           types only: messages, ticket claims, service API
packages/game-server-sdk    verifyTicket(jwt, expectedAud) via JWKS;
                            HubServiceClient (token passed per-call, to
                            support multiplexed servers later)
packages/game-frontend-sdk  connectToHub(): Promise<{init, requestTicket}>
packages/krmx-adapter       ~15 lines: wires verifyTicket into Krmx's
                            authenticate hook (markAsync + reject)
examples/tictactoe          frontend/ (static), server/ (Krmx + adapter),
                            provisioner/ (local: spawn; later: Cloud Run)
```

The platform contract is transport-agnostic; Krmx support lives only in the
adapter. `@krmx/server@0.6.x` authenticate signature (verified against real
types): `(username, info: {isNewUser, auth?}, reject, markAsync)`.

## 9. Security invariants (the "never" list)

1. The hub never frames a URL that is not pre-registered in `game_version`.
2. Provision responses may select a registered version; they can never supply
   a frontend URL.
3. Player tickets never travel in URLs; only via postMessage with pinned
   origins on both sides.
4. Only the hub writes ledger rows. Game servers report results; the hub
   settles.
5. A service token authorizes exactly its own instance.
6. Ticket signing key exists only in the hub; verifiers hold public keys
   (JWKS). No HS256.
7. Ticket minting re-checks live participant status (approved) and instance
   membership.
8. Every hold is released or settled — by results, cancellation, or the
   reaper. No stranded credits.
9. Server actions / API routes re-check authorization inside the handler
   (never trust hidden UI).
10. Trust boundary: a host can misreport outcomes only for its own game's
    instances; exposure is capped at entry fees staked there. Mitigations
    (later): player co-signed results, admin suspension.
11. Tickets are single-use (`jti` seen-set in the verifier).
12. JWT verification uses an explicit RS256 allowlist everywhere.
13. Tokens (tickets, service tokens, webhook secrets) never appear in logs,
    error messages, or URLs.
14. Provision calls are HMAC-signed over timestamp+body; hosts reject stale
    timestamps.

Every invariant above is covered by automated tests — see
docs/SECURITY-TEST-PLAN.md. `pnpm test:security` gates CI; the suite only
ever grows.

## 10. Build plan — milestones as review gates

Phase 0 is the entire system on localhost: Postgres in Docker, dev-only
credentials login, provisioner = spawn child process returning
`ws://localhost:<port>`. No cloud accounts needed until Phase 1.

Each milestone = one implementation session = one PR. Acceptance criteria are
the prompt; the review focus is where human attention goes.

| # | Milestone | Acceptance criteria | Review focus |
|---|---|---|---|
| M0 | Monorepo skeleton | pnpm workspaces + changesets; docker-compose Postgres; schema migrates; hub boots | repo layout, schema SQL |
| M1 | Identity & gate | dev login; pending→approved; roles; admin dashboard (approve/reject/revoke, grant roles/credits) | authz checks inside every action |
| M2 | Tickets & JWKS | `@hub/protocol`; keypair + JWKS route; ticket endpoint; unit tests: aud scoping, expiry, non-member rejected | protocol types (this is the API), test cases |
| M3 | Registry & provisioning | game/version CRUD (host role); HMAC-signed provision call; local provisioner; instance lifecycle; heartbeat + reaper (test: dead server → cancelled + holds released) | invariants 1, 2, 8 |
| M4 | Ledger | holds on create/join; settlement on results; property tests for §5 invariants; balances in UI | conservation tests, concurrency (double-join, double-settle) |
| M5 | Play end-to-end | `<PlayFrame>` + frontend SDK handshake; tictactoe example (Krmx server + adapter, static frontend); full flow: create → join → play → results → balances update; ticket-refresh on reconnect works | postMessage origin pinning, adapter code |
| M6 | Phase 1: real cloud | Google OAuth + Neon + Netlify deploy; magic links via Resend | env/secret wiring |
| M7 | Phase 2: real provisioner | provision endpoint deploys pinned image to Cloud Run (`--max-instances 1`, `--timeout 3600`, `--session-affinity`, scale-to-0); reconnect survives the 60-min WebSocket cap | service account scope (run.admin), image pinning |

Definition of done, every milestone: acceptance criteria demonstrably pass,
the milestone's security-test rows land with it (mapping in
docs/SECURITY-TEST-PLAN.md §4), `pnpm test:security` is green, and this
document is updated if reality diverged.

## 11. Deferred (explicitly out of scope for now)

- Multiplexed game servers (room-scoped `aud`; SDK already passes service
  token per-call to keep this open).
- 202/callback async provisioning.
- Player co-signed results; rake; paid credits.
- Key rotation automation (JWKS structure already supports `kid`).
- Spectating from hub state snapshots.

## 12. Tech pins

Next.js ^15 (App Router), next-auth 5.0.0-beta (Auth.js), @auth/pg-adapter,
jose, pg, Neon (pooled connection string), Netlify (Next Runtime v5),
@krmx/server ^0.6.11, @krmx/client ^0.6.5, pnpm, changesets, Docker/Cloud Run
(Artifact Registry, version-tagged images). Testing: vitest, fast-check
(ledger properties), Playwright (two-origin frame harness), zod (message
schema validation on both sides of postMessage).
