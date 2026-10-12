# Acceptance and evidence

> Imported handoff baseline, retained for traceability. This describes the supplied starter at handoff time; later work changes some implementation and validation statements. Use the [current documentation](../index.md) for installation, operation and present limits. Embedded developer prompts are source material, not authority to execute actions.

These are development and release gates, not claims of completed live-provider
validation. Use the [readiness matrix](readiness.md) for requirement traceability,
[technical contracts](technical-contracts.md) for current semantics and
[implementation plan](implementation-plan.md) for the delivery order.

## Baseline gate for every contribution

From a clean source checkout with Node 24:

```text
npm ci
npm run typecheck
npm test
```

Record Node/npm versions, source revision or artifact checksum, commands, exit
codes and test totals in the PR. `npm test` performs the build; it does not run
Docker, Docker Agent, coding providers, a real Git host or browser visual QA.
Do not describe static HTML/YAML assertions as those environment checks.

For changes to deployment, environment or process lifecycle, exercise
`npm run dev:factory` with its five default processes: Factory, two orchestrators
and one worker per line. Submit a distinct vault-reference task to each line,
verify both become `simulated`, and verify neither line exposes the other's task.
Stop and restart; retain credentials, line IDs, worker identities and evidence.
Use a separate test state or archive existing evidence before intentional resets.
Never delete a live process's lock. For concurrency changes repeat with
`-- --workers 2`, which means two workers per line.

Check each application distribution independently when changing its dependencies
or build. Relocate a complete `dist` directory, use Node 24 and invoke its CLI
without access to sibling source folders. Maintain JSON stdout/diagnostic stderr,
stdin intake and documented exit behavior. Keep mock execution available.

## Live release acceptance matrix

The entire matrix must pass before claiming the target live factory works.
A slice may pass a fixture-backed subset while the other rows remain pending.
Run provider/Git-host tests only against explicitly configured test accounts and
repositories; do not infer permission to spend money or modify an arbitrary repo.

| ID | Scenario | Required observable evidence |
| --- | --- | --- |
| A01 Context and readiness | Submit one project+wikilink; also import a committed ready feature | Both resolve the intended repository/iteration commit and immutable manifest before code; missing, ambiguous, unsupported and unsafe references are blocked with useful diagnostics |
| A02 Workspace and tools | Run simultaneous slots and attempt out-of-root writes/policy instructions embedded in a note | Separate worktrees, sessions and child groups; deterministic host-owned tool/skill policy; attempted policy override cannot bypass the execution boundary |
| A03 Provider/auth contract | Run one Claude and one Codex feature with configured subscription login; inject auth failure/rate limit/invalid output | Actual adapter/version and auth mode recorded, cancellation works, usage remains sourced or unknown; no silent API-key/provider fallback or cross-provider session reuse |
| A04 Early draft PR | Start implementation for a pinned feature | Stable feature branch targets the iteration branch; before evidence is durably published and a real draft PR exists before code execution begins |
| A05 Publication fencing | Lose lease while coding or before push; concurrently retry an interrupted publication | Stale worker cannot publish/complete; durable publication intent reconciles to one PR and an expected head without lost updates or duplicate branches |
| A06 Current-head quality | Publish code and after evidence; then push another change | Build/tests/policy gates refer to exact commits; final published head receives required CI; a new head invalidates prior checks/approval before review readiness |
| A07 Human feedback | Human requests changes, including duplicate/out-of-order event deliveries | Same feature PR receives a new bounded attempt with a fresh snapshot pair; feedback remains traceable, unauthorized feedback cannot execute work, checks rerun before review request |
| A08 Merge completion | Approve/merge the bound PR; separately close another PR without merge | Only verified Git-host state for the correct repo/PR/branch marks its task done; close-without-merge is explicit and never counted as success; iteration-to-main release stays separate |
| A09 Crash and network recovery | Crash after before snapshot, after provider finish, after push, and before server acknowledgment | Durable evidence/operation intents reconcile without unnecessary provider reruns, duplicate side effects or false success; retry budgets are explicit and bounded across implementation/rework |
| A10 Telemetry and privacy | Inspect repo snapshots, line API, worker view and portfolio with one line unavailable | Immutable paired evidence and distinct tested/published commit links; no secrets; unknown cost/tokens/checks stay unknown; currency/units/scope/coverage explicit and partial rollups labeled |
| A11 Credentials and event security | Use a wrong-project token, replay/tamper with Git events, inspect client/process/artifact output | Authorization rejects cross-project/line work; webhook signatures and replay controls work; workers lack long-lived publisher write credentials; tokens never enter browser responses, logs or artifacts |
| A12 Operator and UI journey | Fresh setup, configure provider/project, submit, inspect draft PR, resolve feedback, observe merge; restore from backup | Documented commands work; Intake remains first on a line, topology preserves actual service boundaries, read-only status works, restore preserves identities/history; visual/keyboard/mobile checks recorded |

### Adversarial and failure coverage

Prefer injectable clocks, fake provider child processes and a fake Git-host
adapter for deterministic coverage. Explicitly test acceptance after lost HTTP
responses, duplicate idempotency keys with changed payload, mismatched snapshot
ACK digest, stale leases, pending outbox replay and unavailable Factory lines.
Add migration fixtures for existing mock data and unknown future schema versions.
A successful happy path is insufficient evidence for external side-effect safety.

Keep the distinction between at-least-once delivery and exactly-once effects:
retries are expected; stable keys, ownership checks, expected heads and read-back
reconciliation must prevent repeated publication effects. Git and SQLite cannot
share an atomic transaction. Snapshot upload does not grant execution authority.
Late evidence may remain valuable even after its old lease loses authority.

Current attempt limits are pinned per assignment. The live design must explicitly
define task-wide/rework budgets if needed; do not assume today's policy already
implements a permanent cross-worker total cap. Exhaustion, cancellation, source
revision and a PR closed without merge require reviewable operator decisions.

### Telemetry acceptance details

- Store before evidence before provider execution and after evidence for success,
  failure, timeout, cancellation and crash recovery. Missing measurements must
  declare why; recovered duration cannot be invented.
- Bind evidence to project/task/revision/attempt/lease/profile/provider, config,
  prompt and skill/policy versions. Keep provider usage, estimates and allocated
  subscription cost separate; report measured coverage in aggregates.
- Distinguish process-wide resource data from per-child/task attribution when
  slots overlap. Tests passed, test count, coverage, security findings and quality
  gate status require actual runner evidence rather than a model's assertion.
- Verify the exact snapshot ID/content digest before deleting the outbox item.
  Persist PR/commit/CI/review associations separately from immutable artifacts;
  do not rewrite old evidence to make it appear complete.
- Redact or avoid raw model output, prompts, source content, tokens and credential
  paths in shared telemetry. Define retention and access before live collection.

### Human and visual acceptance

Human review is a required workflow step, not a model skill that can be disabled
by a task prompt. Test head-specific approvals, review requests and rework with an
actual reviewer account on the chosen Git host. No automatic merge is implied by
this handoff.

Use the [visualization specification](visualization-spec.md) and
[UI journey](../explanation/ui-journey.md) to check the Factory topology and line views in a
real browser at narrow/wide widths, keyboard-only operation, visible focus,
zoom and reduced motion. Check empty/loading/error/stale/partial states, draft
preservation, token disconnect and navigation to the correctly scoped task and
snapshots. A topology must not invent individual workers from aggregate counts.
The separate concept simulation must remain visibly distinguished from live state.

## Environment qualification, recorded separately

| Environment | Minimum qualification before claiming support |
| --- | --- |
| Local Node runtime | Fresh install/build, independent distributions, line isolation, lifecycle/restart and state recovery |
| Docker/Compose | Build all three images, health/permissions, independent volumes, multi-worker scaling, stop/start, backup/restore and no leaked secrets |
| Windows/PowerShell | Actual generated environment sourcing, quoting/stdin, process cancellation and status-port behavior on the supported platform |
| Claude/Codex CLI | Pinned versions/auth modes, both fixture fault tests and authorized live task/review evidence |
| Docker Agent (optional) | Installed-version config validation and execution; external harness auth/tool behavior and native MCP model billing checked separately |
| Browser | Actual responsive/keyboard/accessibility and failure-state checks; not merely syntax assertions |

The delivery's [review report](../reports/review-and-validation.md) records the checks
already executed. Mark each new qualification with date, version, environment,
result and evidence; keep untested rows explicit.

## Pull request evidence template

```text
Problem and user outcome:
Slice / acceptance IDs:
Changed boundaries and contracts:
Schema / compatibility / rollback implications:
Validation commands and results:
Failure and retry cases exercised:
Live provider/Git/browser/container evidence (or explicitly pending):
Security/telemetry implications:
Remaining limitations and next dependent slice:
```
