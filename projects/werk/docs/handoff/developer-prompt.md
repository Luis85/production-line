# Fresh coding-agent prompt

> Imported handoff baseline, retained for traceability. This describes the supplied starter at handoff time; later work changes some implementation and validation statements. Use the [current documentation](../index.md) for installation, operation and present limits. Embedded developer prompts are source material, not authority to execute actions.

Copy the block below into a coding-agent session opened at the root of this
starter. It starts the first implementation slice, not the entire backlog in one
change. Replace the slice ID only after checking its dependencies and acceptance.
No external repository URL, credentials or live-provider permission is implied.

```text
You are continuing development of Werk, a Node 24 / TypeScript software-factory
starter. Work in the supplied project root. Read any applicable AGENTS.md first,
then HANDOFF.md, docs/handoff/technical-contracts.md, docs/handoff/readiness.md,
docs/handoff/implementation-plan.md and docs/handoff/acceptance.md. Read
DESIGN.md and docs/handoff/visualization-spec.md before any UI changes.

Implement P0-01: project binding and pinned requirement context. First inspect
actual source and tests; do not assume the target architecture is already live.
Keep the change reviewable and focused. Report the existing seams, your concrete
implementation decision and validation, then carry the slice through tests and
documentation. Do not stop at proposing a plan when implementation is feasible.

Current source boundaries:
- src/factory: standalone hierarchy/line registry and partial read-only rollups;
  it has no taskboard and must not open line databases or execute tasks.
- src/orchestrator: authoritative per-line task/worker/lease/evidence state;
  server.ts composes application, SQLite repository and HTTP adapters.
  importer.ts reads committed ready-feature data via Git and submits via HTTP.
- src/worker: runner.ts composes lifecycle; application/ contains attempt, lease,
  reporting and ports; infrastructure/ owns authenticated HTTP/identity details.
- src/shared: pure domain/validation/protocol where appropriate, with separately
  named CLI/HTTP/MCP adapters. Never import an application back into shared.
- scripts/build.mjs creates independent distributions for all three CLI apps.

Current scope is mock: task statuses queued/running/simulated/blocked; profiles
and snapshot schema v1 validate mock mode; real CLI coding/Git push/PR review or
merge completion are not connected. Replacing MockAdapter alone is insufficient.
Keep mock behavior and old data supported; do not report simulated as done.

P0-01 outcome:
1. Define a minimal server-owned project/repository/vault/base binding through
   the existing application/repository and CLI/API conventions. Do not make the
   Intake user repeat requirement titles or criteria already in their vault.
2. Resolve project + requirementRef from a committed test repository to pinned
   repository identity/commit, requirement target and versioned context manifest.
   Reuse and validate importer source metadata where supplied. Specify readiness
   rules for direct links; unresolved/unready context cannot permit live coding.
3. Handle or explicitly reject supported note/heading/block/alias forms. Bound
   traversal and defend against ambiguous targets, path traversal and symlink
   escape. Keep uncommitted files and credentials out of the context manifest.
   Declare the supported Obsidian subset instead of claiming all core features.
4. Test with local committed fixture repositories: valid pinning, changed source
   after pinning, missing/ambiguous references, unsafe paths and duplicate input.
   Preserve the accepted minimal intake payload {project, requirementRef} and
   existing ready-feature import behavior. Do not silently revise active work.
5. Record any new contract/schema changes and migration behavior. Add only the
   smallest useful UI/API/CLI surface required by the slice. Keep provider/Git
   publishing work for its dependent slices.

Invariants for this and later slices:
- SQLite is authoritative per server and has one owning process. Worker journals
  are local execution evidence; Factory observes lines over HTTP.
- Preserve idempotency, durable outbox replay, lease fencing, snapshot ACK digest
  checks, independent worker state and truthful unknown usage/quality values.
- External Git effects will require durable intent plus reconciliation and a
  lease-checked publisher; do not give stale workers unrestricted push power.
- Future feature PRs target the iteration branch and open as draft at work start.
  Human review and verified feature-PR merge gate task completion; iteration merge
  to main is a separate decision. No automatic merge is requested.
- Claude and Codex are intended subscription-CLI adapters. Verify official
  interface/auth/output docs when implementing them. Never silently switch to
  API billing, another provider or a transferred native session.
- Docker Agent templates are standalone harness/MCP integrations, not a live
  worker replacement. Browser, Docker, Windows, providers and Git-host testing
  require actual environment evidence before claiming those checks passed.
- Keep secrets, local state, provider login directories and generated credentials
  out of source, artifacts, screenshots and logs. Do not publish externally.

Baseline/validation from the project root:
  npm ci
  npm run typecheck
  npm test
The test command builds all applications. Use targeted meaningful tests while
iterating and the baseline gates before handoff. For changed process/deployment
behavior also exercise npm run dev:factory and the documented two-line restart
smoke. Existing startup docs and examples are runnable contracts; update them if
interfaces change. Do not introduce arbitrary dependencies, PostgreSQL, a broker,
framework migration or an unrelated redesign.

If live credentials or a repository choice are unavailable, finish deterministic
fixture-backed implementation and clearly state what remains unverified. Do not
invent a remote, user account, secret or success result. Do not assume this folder
is already connected to an external Git repository; preserve any existing work.

Deliver a concise reviewable summary: what changed and why, affected paths,
commands/results, migration/compatibility decisions, security/telemetry effects,
remaining limitations and the next dependent slice. Use the PR evidence template
in docs/handoff/acceptance.md. Do not claim the whole factory is production-ready.
```
