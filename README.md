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

## Phase 0 (current): everything on localhost

No cloud accounts needed. `docker compose up -d` for Postgres; dev-only
credentials login; the example game's provisioner spawns local child
processes. Real OAuth/Neon/Netlify arrive in M6, Cloud Run provisioning in M7.
