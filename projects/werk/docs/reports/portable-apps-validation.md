# Portable apps validation — 2026-10-13

Factory, orchestrator and worker now build as individually copyable Node 24 apps
under `bin/apps/`. Each carries its webview, compiled application and dependencies.
The shared operator interface provides foreground/detached lifecycle commands,
authenticated status/stop, JSON discovery, task submission and management APIs.
See the [portable app contract](../reference/portable-apps.md).

## Acceptance evidence

The integration test copies each application into a separate unrelated CommonJS
project, with spaces in its path, no source checkout and no npm install. It verifies:

- Two standalone workers have different ports, run identities, private credentials
  and sessions. Copying an app does not copy runtime data.
- Detached startup returns readiness and a credential file path, never the token.
  A second owner is rejected, as is state placed inside the copied app folder.
- Local authenticated clients work; explicit remote URLs cannot receive discovered
  local credentials. Unauthenticated task creation is rejected.
- Agent task commands target session IDs without changing the browser selection.
  Stable task IDs prevent duplicate creation and reject changed input. Retrying
  after a user renames a task still finds the original submission.
- Queue pause, task cancellation, follow-up turns and worker restart preserve
  session history, identity and credentials. A second worker remains unaffected.
- A labelled native Linux model fixture receives two tasks in strictly serial
  start/end order and returns responses into their separate sessions.
- Explicit file tasks return a patch ready for review; the source file is unchanged.
- A previously standalone worker enrolls into a new orchestrator. Factory is then
  started, registers that line, accepts idempotent intake and routes a task that
  finishes as explicitly simulated.

## Checks

`npm run check` passed: **534 tests, 533 passed, zero failed, one platform skip**.
This includes TypeScript/Vue checks, all three builds and the copied-app test.
Dependency audit found zero vulnerabilities. Strict documentation validation,
workflow drift and whitespace checks passed.

Both release formats packaged successfully and checksum/file verification passed
on extraction. The native extracted-release smoke test completed a simulated task,
retained both snapshots and preserved identity/evidence through a real restart.
Docker build stages retain their existing independent distributions using the
explicit `--dist-only` build option; source CI still builds all three Docker images.

Validation exposed and corrected an unhandled rejection on conflicting task IDs,
mutable-title idempotency, and a release documentation check that incorrectly tried
to resolve upstream YAML contributor links inside a nested portable dependency.

The worker lifecycle was also exercised separately through its real webviews in
18 screenshots: setup, guided tour, task/follow-up, approved file task, queue pause,
serial execution, cancellation/retry, patch review, dashboard/resources, enrollment,
assigned history, restart, session controls, standalone return and shutdown. That
storyboard is delivered as an illustrated Page, self-contained HTML and 18-page PDF.
Screenshots use an explicitly labelled test executable and simulated assignments.

## Limits

These are local Linux results; the PR CI matrices qualify Windows/macOS and Docker.
Authenticated live subscription/API execution was not qualified. A protocol fixture
is not a live model. File tasks produce patches and do not apply them or execute
repository tests. Portable apps require Node 24; provider CLIs and their login are
host prerequisites. Logs use the operator's retention policy. Upgrading a copied
app is an explicit stop, backup, replace and restart operation; this change does
not add automatic self-replacement to the portable CLI.
