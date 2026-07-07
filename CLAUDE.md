# CLAUDE.md — Krmx Hub

## Who does what

Simon is the architect and reviewer; Claude implements. Simon does not write
code. Your job is to turn the specs into working, tested code — and to push
back *in conversation* when a spec seems wrong, never by silently diverging.

## Read first, every session

1. `docs/ARCHITECTURE.md` — the constitution. §9 lists security invariants
   that must NEVER be violated.
2. `docs/SECURITY-TEST-PLAN.md` — the adversarial test matrix.
3. The current milestone prompt in `docs/prompts/` (Simon will say which).

## Hard rules

- **Doc-first changes.** If implementation reveals the spec is wrong or
  incomplete, propose an edit to the doc, get Simon's approval, update the
  doc, then change code. The docs and code must never disagree.
- **One milestone per session/PR.** Do not start the next milestone, do not
  build anything listed in ARCHITECTURE.md §11 (Deferred), do not add
  features that were not asked for.
- **Tests first at the seams.** For anything touching tickets, tokens,
  ledger, provisioning, or postMessage: write the security-matrix tests for
  this milestone (SECURITY-TEST-PLAN.md §4 mapping) before or alongside the
  implementation. Test titles must include their matrix IDs (e.g. `T-02`).
- **`pnpm test` and `pnpm test:security` must be green** before a milestone
  is declared done. Security tests are never deleted or weakened.
- Never log or interpolate tickets, service tokens, or webhook secrets
  (invariant §9.13). Never put tickets in URLs (§9.3).
- All JWT verification: `jose` with explicit `{ algorithms: ['RS256'] }`.
- Ledger writes happen only in hub-internal settlement/join/grant/reap code
  paths (§9.4). Every API route and server action re-checks authorization
  inside the handler (§9.9).

## What Simon reviews (surface these clearly in your summary)

- Changes to `packages/protocol` (this is the platform API).
- SQL schema/migrations and ledger logic.
- The security-critical seams: JWKS/ticket verification, `aud` + `jti`
  checks, service-token comparison, postMessage origin pinning, provision
  HMAC.
- Any spec deviation you had to make (there should be none without approval).

CRUD plumbing and React components can pass on green tests alone; keep those
diffs boring and conventional.

## Environment & commands

- Node 20, pnpm. `docker compose up -d` starts local Postgres
  (localhost:5432, user/pass/db: hub/hub/hub).
- Workspace layout (target — M0 creates it):
  `apps/hub`, `packages/{protocol,game-server-sdk,game-frontend-sdk,krmx-adapter}`,
  `examples/tictactoe/{frontend,server,provisioner}`, `security/`.
- Phase 0 is localhost-only: dev credentials login (NODE_ENV guard), local
  provisioner spawns child processes, no cloud accounts, no real OAuth.
- Root scripts to maintain: `dev`, `build`, `test`, `test:security`, `db:up`,
  `db:migrate`.

## Style

TypeScript strict everywhere. Zod-validate all external inputs (API bodies,
postMessage payloads, provision responses). Prefer boring, readable code over
clever code — the reviewer reads seams, tests document intent.
