# Project worker and Markdown feature requests

Validated on 14 October 2026 (Europe/Berlin) with Node 24 on Linux. This is a
feature-specific implementation and engineering review; it does not claim a new
visual audit or authenticated provider qualification.

## Delivered behavior

The portable worker now installs into an existing project, including a plain
folder without Git or npm dependencies. `init` copies the self-contained app,
seeds private state/configuration and a standalone Compose file, and installs a
customizable draft template. Repeated setup preserves operator edits and rejects
conflicting configuration. Terminal and Docker runs share the same project state
and must be stopped before switching between runtimes.

The configurable feature folder accepts YAML frontmatter plus Markdown. Stable
ready files enter the existing serial executor; drafts never prompt a model.
Each request gains a durable ID, task/session references, status, and readable
result/patch references. Orchestrator assignments are mirrored without local
redispatch. `_worker-status.md` and the authenticated `feature list` command make
intake and lifecycle state visible without a browser.

## Review and corrections

- Preserve Markdown bytes, YAML comments and custom metadata when updating status.
- Reserve identity and captured input before queue admission, including retrying
  a failed reservation write before a later scan can submit work. Duplicate IDs,
  renamed requests, edited accepted files and restarts cannot silently create new work.
- Keep the existing task/session executor as the sole execution owner. Feature
  intake adds no parallel model process and exports patches for explicit review.
- Refuse overlapping private state, symlinked inputs/results and second consumers.
  Use bounded YAML parsing and explicit recovery instructions for stale locks.
- Let the template inherit the configured provider instead of hard-coding Codex.
- Support project setup without an implicit Git requirement. Retain the existing
  explicit `--project-dir` contract for journal-aware launches.
- Exclude private lease/artifact paths from exported orchestrator summaries;
  retain full attempt evidence in private worker history.
- Generate unique Docker project names, use the setup operator's UID/GID and a
  pinned Node image, and preserve app files as a read-only nested mount.

## Qualification

Focused validation passed 37 checks, followed by an 11-check feature-suite rerun
including the new private-index write failure case. These cover native installation and
restart, file intake, review patches, serial execution, admission recovery,
malformed input, duplicate IDs, folder ownership, template preservation/provider
inheritance, orphaned history, and real runner integration with orchestrator
assignments. Existing lifecycle and provider-fixture checks that exceeded timing
budgets under competing local workloads passed when rerun without contention;
application assertions and health deadlines remain unchanged. The legacy Docker
harness now allows 300 seconds per wrapper command for image preparation and
container creation; its previous 150-second driver budget expired during this
environment's slow container startup. The longer diagnostic reached healthy
worker and orchestrator states. Complete matrix results are recorded by PR CI.

Both generated archive formats passed checksum, manifest and extraction
verification. The extracted native release completed a simulated task, retained
two snapshots, and preserved identity through restart. The extracted project
worker completed Docker-contained setup, generated its template, ingested a
host-mounted request, exported a result and restarted without duplicate tasks.
The Docker project journey is also a release CI gate.

## Boundaries

Provider execution in these checks uses explicitly labelled protocol fixtures;
it is not evidence of a working paid subscription or API account. The installed
Docker image requires an API connection or an operator-provided image with the
chosen CLI and its own authentication. Native Windows/macOS behavior is covered
by the existing CI matrix, not claimed as locally executed here.

Intake polls stable root-level `.md` files. Accepted input is immutable; edits or
file deletion do not cancel or replace work. Private state and the owned feature
folder must move together. Interrupted tasks use existing worker recovery rules,
and a stale crash lock requires verifying the prior process has stopped before
removal. The private feature index is bounded to 1,000 records. Chat sends the
request body; patch mode reads only explicitly approved files and never applies
its patch or runs project tests automatically.

See [project setup](../how-to/project-worker.md) and the
[request contract](../reference/feature-requests.md) for operating instructions.
