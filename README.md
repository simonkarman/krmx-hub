# Krmx Hub

A hub for Krmx-based multiplayer games: the hub owns identity, admin approval,
roles, credits, and the game/instance registry; games run independently
(host-operated servers on Cloud Run, versioned static frontends embedded via
sandboxed iframe + postMessage).

## Documents

- **docs/ARCHITECTURE.md** — the project constitution: actors, credentials,
  data model, flows, embedding contract, security invariants (§9), milestone
  plan (§10).
- **docs/SECURITY-TEST-PLAN.md** — threat model + adversarial test matrix;
  `pnpm test:security` gates CI.
- **CLAUDE.md** — standing instructions for AI implementation sessions.
- **docs/prompts/** — one kickoff prompt per milestone (M0–M7).

## Workflow

1. Start an implementation session (e.g. Claude Code) in the repo root.
2. Say: "Implement M0 per docs/prompts/M0.md" (then M1, M2, ...).
3. Review the PR at the seams listed in CLAUDE.md; everything else rides on
   green tests.
4. Spec changes go to the docs first, code second.

## Milestone status

| # | Milestone | State |
|---|-----------|-------|
| M0 | Monorepo skeleton | ✅ done |
| M1 | Identity, approval gate, roles, admin dashboard | ✅ done |
| M2 | Protocol package, ticket minting, JWKS | ✅ done |
| M3 | Registry, provisioning, instance lifecycle, reaper | ✅ done |
| M4 | Ledger (holds, settlement, conservation) | ✅ done |
| M5 | Play end-to-end (`<PlayFrame>`, frontend SDK, tictactoe) | ⬜ next |
| M6 | Phase 1: real cloud (OAuth, Neon, Netlify) | ⬜ |
| M7 | Phase 2: real provisioner (Cloud Run) | ⬜ |

## Workspace layout

```
apps/hub                       Next.js app (frontend + API routes, DB migrations)
packages/protocol              platform API: ticket claims, postMessage + service/provision schemas (zod)
packages/game-server-sdk       verifyTicket() via JWKS; provision-call HMAC sign/verify
packages/game-frontend-sdk     connectToHub() handshake (M5)
packages/krmx-adapter          wires verifyTicket into Krmx's authenticate hook (M5)
examples/tictactoe/{frontend,server,provisioner}
security/                      Vitest + Playwright adversarial suite (mirrors the test matrix)
```

## Running locally (Phase 0)

No cloud accounts needed. Requires Node 20 and pnpm; Docker for Postgres.

```bash
pnpm install
pnpm db:up          # start local Postgres (localhost:5432, hub/hub/hub)
pnpm db:migrate     # apply apps/hub/db/migrations/*.sql
pnpm dev            # hub on http://localhost:3000
```

Then, on the hub:

- Visit `/signin` and enter any email (dev-only credentials login, guarded by
  `NODE_ENV`). The first sign-in lands in **pending**; `ADMIN_EMAIL`
  (default `mail@simonkarman.nl`) is bootstrapped as an approved admin.
- As admin, open `/admin` to approve users and grant host/admin roles and
  credits. As a host, open `/host` to register games and versions.

Optional env (`apps/hub/.env.example`): `TICKET_PRIVATE_KEY` (an ephemeral
dev keypair is generated if unset), `AUTH_SECRET`, `ADMIN_EMAIL`, `HUB_URL`.

### Provisioning round-trip (the tictactoe example)

A host registers a game + version whose `provisionUrl` points at the local
provisioner, then a user creates an instance. The hub makes an HMAC-signed
provision call; the provisioner verifies it, spawns a placeholder game server,
and returns `ws://localhost:<port>`; the hub stores that opaque URL and moves
the instance to `lobby`.

```bash
pnpm build
# start the provisioner with the game's webhook secret (shown once when the
# game is created, or read from the game row locally):
WEBHOOK_SECRET=<secret> PORT=4100 node examples/tictactoe/provisioner/dist/index.js
```

## Testing

```bash
pnpm test           # all workspace tests (includes the security suite)
pnpm test:security  # the adversarial matrix only (needs db:up + db:migrate)
```

The security suite boots a production hub build on a throwaway port and drives
it over HTTP. Test titles carry their matrix IDs (e.g. `T-02`, `S-01`); a
meta-test fails if a landed matrix row has no matching test.
