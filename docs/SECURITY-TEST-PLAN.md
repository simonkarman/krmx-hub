# Krmx Hub — Security Test Plan

> Companion to docs/ARCHITECTURE.md. Every invariant in §9 of the architecture
> must be covered by at least one automated test in this plan. The suite runs
> fully locally (`pnpm test:security`) and gates CI. New attack ideas become
> new rows, never ad-hoc manual checks.

## 0. Design deltas this plan forced (already folded into ARCHITECTURE.md §4, §6.1, §9)

1. **Single-use tickets.** Add a `jti` (random id) claim. The server-side
   verifier (krmx-adapter) keeps an in-memory seen-`jti` set with TTL equal to
   ticket lifetime and rejects reuse. Legitimate reconnects always request a
   fresh ticket via `hub:request-ticket`, so this breaks nothing and turns a
   leaked-in-transit ticket from "2-minute impersonation" into "race you to
   first use".
2. **Provision-call replay protection.** The HMAC signature covers
   `timestamp + "." + body`; the host endpoint rejects timestamps outside a
   ±60s window and (optionally) remembers recent signatures.
3. **Explicit algorithm allowlist.** Every `jwtVerify` call passes
   `{ algorithms: ['RS256'] }`. Never derive the algorithm from the token
   header.
4. **Rate limiting** on `/api/instances/:id/ticket` and sign-in (per session /
   per IP), so ticket minting can't be used as an oracle or spam vector.
5. **Logging hygiene rule:** tokens (tickets, service tokens, HMAC secrets)
   never appear in logs, error messages, or URLs. Enforced by a grep-style
   lint test over captured log output in E2E runs (H-04).

## 1. Threat model — attacker capabilities

| Actor | Holds | Wants |
|---|---|---|
| Outsider | nothing / leaked artifacts | play without account, forge identity |
| Leaked player ticket | one valid ticket (e.g. pasted in Discord) | impersonate the player, reach other instances, call hub APIs |
| Malicious approved user | valid session | others' credits, other instances' tickets, admin/host actions |
| Revoked user | stale session and/or unexpired ticket | keep playing / rejoin |
| Malicious host | own game, provision endpoint, all service tokens for own instances | mint identities, settle foreign instances, inflate own payouts, get hub to frame arbitrary URLs |
| Malicious game frontend | JS inside the sandboxed iframe | hub cookies/DOM, tickets for other instances, phish via navigation |
| Network observer (local model) | request/response transcripts | replay anything captured |

Blast-radius targets the design promises (tests must confirm):
- Leaked **ticket** ⇒ at most: link once (jti), as that user, to that one
  instance, within 2 minutes. Nothing else.
- Leaked **service token** ⇒ at most: heartbeat/state/results for that one
  instance until settled/reaped. No identity, no ledger writes beyond that
  instance's settlement, no ticket minting.
- Malicious **host** ⇒ at most: misreport outcomes of own instances (exposure
  capped at entry fees staked there). Cannot touch other games, other
  ledgers, or the framing allowlist.

## 2. Test matrix

Legend: [U] unit/integration (Vitest, real Postgres), [B] browser (Playwright,
two-origin harness), [P] property-based (fast-check).

### T — Player tickets (forgery, confusion, replay)

| ID | Scenario | Expected |
|---|---|---|
| T-01 | `alg: none` token | rejected |
| T-02 | **Algorithm confusion:** token HS256-signed *using the hub's public key as the HMAC secret* | rejected (allowlist) |
| T-03 | RS256 signed with attacker's own keypair | rejected |
| T-04 | Expired ticket (2m+skew) | rejected |
| T-05 | Valid ticket for instance A presented to server B (`aud` mismatch) | rejected |
| T-06 | Valid ticket, Krmx `link(username)` ≠ `name` claim | rejected |
| T-07 | Payload tampered after signing | rejected |
| T-08 | Same ticket used for two links (replay) | second rejected (jti) |
| T-09 | Ticket presented as hub API credential (Authorization header on any hub route) | 401 — tickets are not sessions |
| T-10 | `kid` pointing at unknown key | rejected |
| T-11 | Happy path: fresh valid ticket | accepted exactly once |

### A — Hub API authorization (session-side)

| ID | Scenario | Expected |
|---|---|---|
| A-01 | Pending user: create/join/ticket | 403 |
| A-02 | Blocked user with still-live session: any gated route | 403 |
| A-03 | Approved non-member requests ticket for an instance | 403 |
| A-04 | Ticket request for finished/cancelled instance | 403 |
| A-05 | Non-admin calls approve/roles/grant endpoints & server actions directly (bypassing UI) | 403 |
| A-06 | Non-host registers game/version | 403 |
| A-07 | Host A edits Host B's game/version | 403 |
| A-08 | Anonymous: catalog readable; everything else 401 |
| A-09 | Revoke user mid-flow: next ticket mint fails even though session valid | 403 |
| A-10 | Ticket endpoint rate limit: N+1th rapid request | 429 |

### S — Service tokens

| ID | Scenario | Expected |
|---|---|---|
| S-01 | Instance A's token on instance B's heartbeat/state/results | 403 |
| S-02 | Token after settlement | 401 (revoked) |
| S-03 | Token after reaper cancellation | 401 |
| S-04 | Random/tampered token | 401 |
| S-05 | Service token used on user/admin routes or ticket minting | 401 |
| S-06 | Results with valid token but ranking includes a non-player email | rejected, no ledger writes |
| S-07 | Token accepted only via Authorization header, never query param |

### L — Ledger integrity (run inside real Postgres transactions)

| ID | Scenario | Expected |
|---|---|---|
| L-01 | Replay of results (double-settle) | second call idempotent/409; payouts written once |
| L-02 | Settle after cancel / cancel after settle | rejected; state machine enforces one terminal transition |
| L-03 | Payouts exceeding pot (Σpayout > −Σholds) | rejected atomically |
| L-04 | Negative/zero-invalid amounts in results | rejected |
| L-05 | Double-join same user | one hold, one player row (PK + idempotency) |
| L-06 | Concurrent joins racing last credit (parallel txns) | at most one succeeds; balance never < 0 |
| L-07 | Concurrent settle + reap on same instance | exactly one wins; every hold released or captured exactly once |
| L-08 [P] | Random interleavings of grant/create/join/cancel/settle | invariants hold: balance = Σamount ≥ 0; every hold terminally resolved once; per-instance conservation |
| L-09 | Reaper on dead server (no heartbeat) | instance cancelled, holds released, token revoked |
| L-10 | User calls any ledger-writing path directly | impossible — only hub-internal settlement/join/reap code writes rows (route audit test) |

### P — Provisioning & registry

| ID | Scenario | Expected |
|---|---|---|
| P-01 | Unsigned / wrongly-signed provision call to host endpoint | rejected by host SDK |
| P-02 | Replayed provision call (stale timestamp) | rejected |
| P-03 | Provision response contains `frontendUrl` field | ignored; hub frames only registered URL |
| P-04 | Provision response names an unregistered/revoked version | instance creation fails, hold released |
| P-05 | Host registers frontend_url on origin outside their allowlisted set (if origin vetting enabled) | rejected at registration |
| P-06 | Provision timeout (endpoint hangs > 60s) | instance cancelled, hold released |

### F — Iframe & postMessage (two-origin browser harness)

| ID | Scenario | Expected |
|---|---|---|
| F-01 | Evil page at unregistered origin posts `hub:ready`/`hub:request-ticket` | hub ignores (origin check); no ticket posted |
| F-02 | Hub posts `hub:init` with pinned targetOrigin; evil frame swapped in via navigation | message not deliverable to wrong origin |
| F-03 | Game iframe reads hub cookies / touches hub DOM | impossible (cross-origin); assert document.cookie empty & parent access throws |
| F-04 | Ticket never in any URL: crawl performance entries + history during full play flow | zero matches for ticket pattern |
| F-05 | CSP `frame-src`: hub page attempts to embed unregistered origin | frame blocked |
| F-06 | `hub:init` sent only after membership-verified ticket fetch; non-member's frame gets nothing |
| F-07 | Message with correct origin but malformed schema | ignored (zod-parse both directions) |

### H — Hygiene

| ID | Scenario | Expected |
|---|---|---|
| H-01 | Grep production code for HS256/shared-secret ticket paths | none |
| H-02 | jwtVerify call sites all pass explicit `algorithms` | enforced by lint rule/test |
| H-03 | service_token stored only as sha256 hash (DB column audit) | no plaintext |
| H-04 | Captured logs from full E2E run contain no ticket/service-token/webhook-secret material | zero matches |

## 3. Local harness

- **Origins:** different ports are different origins, which is all the
  browser security model needs: hub at `http://localhost:3000`, game frontend
  at `http://localhost:4000`, an **evil frontend** at `http://localhost:4666`
  serving attack pages (F-tests). All three started by the Playwright config.
- **DB:** docker-compose Postgres; L-tests run against it directly
  (transactions + fast-check), not through HTTP, so races are controllable.
- **Keys:** test RSA keypair checked into `test/fixtures` (never used outside
  NODE_ENV=test); forgery tests carry their own attacker keypair.
- **Game server:** the tictactoe Krmx server booted as a child process per
  test file; T-tests drive a raw `@krmx/client` against it with crafted
  tokens.
- **Structure:** `security/` workspace package with `tickets/`, `authz/`,
  `service/`, `ledger/`, `provision/`, `frame/`, `hygiene/` mirroring the
  matrix; test IDs in test titles so coverage of this document is greppable.
- **CI gate:** `pnpm test:security` runs everything headless; a matrix-row
  without a matching test title fails a meta-test (spec-coverage check).

## 4. Milestone mapping

Each architecture milestone lands with its rows: M2 → T + H-01/02, M3 → P,
S-01..05, L-09; M4 → L; M5 → F, T-08, S-06, H-04. The suite is cumulative —
security tests are never deleted, only added.

## 5. Honest limits of local testing

Local tests prove the *logic*; they cannot prove: TLS everywhere (deploy
config), secret storage hygiene in Netlify/Cloud Run env, timing-safe token
comparison (use `crypto.timingSafeEqual`; code-review item), DoS resilience
beyond basic rate limits, or that a real host's infrastructure is sound.
Those live in a short deploy-time checklist, not this suite.
