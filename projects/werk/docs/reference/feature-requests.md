# Markdown feature requests

The Feature Request is the parent workflow entity. Intake accepts it; sessions,
execution requests, attempts, Task questions, gate evaluations and review notes
refer back to it. A source note is one UTF-8 Markdown file with YAML frontmatter.
The worker's existing serial executor owns attempts; an authoring channel does
not create another execution workflow.

For the team workflow, use [shared Git intake](../how-to/shared-feature-intake.md).
The webview, connected CLI and offline authoring skill produce the same configured
request template. Ready requests and Task responses must reach the watched remote
branch before execution. Private workers without a shared binding can use direct
interaction or local folder intake, where stable local saves trigger admission.
See [project setup](../how-to/project-worker.md).

## Feature Request identity

The worker exposes a `feature` reference with stable `key`, source `id`, `source`
and `scope`, plus a source path and repository ID when applicable. The supported
sources are `interaction`, `folder`, `shared_git` and `orchestrator`. Sessions,
approved-file tasks and gate requests retain that parent identity; child execution
IDs still identify their own attempts and evidence. Older retained records derive
a compatible reference without submitting or replaying work.

Shared Task and PullRequest notes include `featureRequestKey` and their source
feature ID. A new turn, retry or answer keeps the same parent. Generated tracking
is a projection, not an independent authoring authority or a second request to
schedule. Changing shared requirements after acceptance requires a successor
Feature Request.

## Canonical local delivery requests

Local delivery uses `schema: worker.request/v1` on the same Feature Request and
serial executor. The existing shared Git authoring contract below retains its
commit-and-push handoff and ownership rules. Do not convert an actively shared
note into local intake to bypass those rules.

```yaml
schema: worker.request/v1
id: FR-0042
title: Export the filtered backlog
intent: draft
priority: normal
quality_profile: feature
depends_on: []
mode: patch
paths:
  - src/export.ts
```

Use YAML frontmatter around these fields and Markdown sections for Outcome,
Scope, Acceptance criteria, Boundaries, References and Answers. Change `intent`
to `submit` when ready. A missing intent or ID is invalid, rather than an implicit
submission. The quality profile must resolve to an allowed project profile;
request text cannot grant tools or weaken trusted checks. `feature` and
`lightweight` distinguish required inputs while keeping one lifecycle.

| Field | Canonical local contract |
| --- | --- |
| `schema` | Required `worker.request/v1`. |
| `id` | Required stable request identity; preserve it when renaming or revising the same work. |
| `intent` | Explicit `draft` or `submit`; a retained submit intent cannot reopen terminal work. |
| `priority` | `low`, `normal`, `high` or `urgent`; scheduling changes do not create a new requirement revision. |
| `quality_profile` | An allowed named quality profile; omission uses the configured default. |
| `execution_profile` | Optional named provider profile allowed by the committed project policy. Explicit provider/model/effort or definition fields must agree with that selection. |
| `depends_on` | Same-project request IDs or `repositoryId:requestId` references; unknown references, cycles and prerequisites absent from the selected baseline hold dispatch. |
| `review`, `control` | Guarded candidate decisions and execution controls described below, separate from requirement content. |
| `readiness_decision`, `criterion_decision` | Exact-subject decisions permitted by the accepted policy; see [readiness and criterion decisions](../how-to/configure-delivery-readiness.md). |
| `publication` | Explicit optional GitHub push, remote PR or reconciliation command under an approved integration policy; see [candidate publication](../how-to/publish-worker-candidates.md). |
| `local_merge` | Explicit candidate-bound main-checkout merge or read-only reconciliation under approved `localMerge: true` policy; see below. |

Provider/model/effort, approved file scope and instruction-profile selectors use
the same authority boundaries as legacy intake. Worker-owned status, questions,
findings and references belong between `<!-- worker:begin -->` and
`<!-- worker:end -->`. The user owns the surrounding text. Generated edits,
cosmetic blank-line changes, scheduling priority and command metadata do not
create new requirement revisions. Code indentation and Markdown hard breaks
remain meaningful.

Material edits to nonterminal work hold new actions while the worker reconciles
execution and reassesses the same request. Terminal work requires an explicit
reopen command. Missing, duplicated or invalid active sources produce a visible
hold; restoring the source or cancelling resolves that condition. Conflicting
writes retain recoverable content rather than silently replacing a newer save.

### Candidate decisions and execution controls

Read current IDs from the worker-managed projection or request detail before
issuing a command. `request_revision` is the numeric requirement input revision;
`candidate_commit` is the complete Git commit ID, not a branch name. A decision
must identify the offered result:

```yaml
review:
  command_id: CMD-0042-review-01
  decision: accept
  request_revision: 2
  candidate_commit: <complete candidate commit from the review package>
  human_checks:
    - criterion_id: "human:1:0123456789ab"
      outcome: pass
      note: Verified the exported rows against the active filters.
```

Copy the criterion IDs from the current package; the example ID above is illustrative.
Each mandatory human criterion needs a matching outcome and supporting note.
An empty list is sufficient only when no required human criteria remain. Exemptions
are separate authorized decisions, never fabricated passing checks. Use
`decision: request_changes` with `feedback` or a user-owned `## Review feedback`
section to request changes to that candidate.

```yaml
control:
  command_id: CMD-0042-pause-01
  action: pause_after_step
  run_id: <current delivery run ID>
  request_revision: 2
```

Supported control actions are `pause_after_step`, `interrupt`, `cancel`, `resume`,
`retry`, `confirm_stopped` and `reopen`. `confirm_stopped` requires the current
run and request revision plus a note attesting that the operator inspected the
host and stopped the previous processes. It resolves an unknown cessation state,
not an implementation result, and does not resume work. Follow the
[recovery procedure](../explanation/local-delivery-worker.md#execution-and-evidence)
before issuing it. Run-targeting actions need the current `run_id`; reopening
terminal work uses a fresh command ID. Intake pause is a project action, separate
from the selected run's step pause. Stop requests remain pending until the
execution outcome is known; uncertain work must be reconciled before retry.

### Main-checkout merge from Markdown

After reviewing and accepting the exact current candidate, `local_merge` carries the same explicit permission as the webview. The committed accepted policy must enable `localMerge: true` and have its exact local approval. Copy the destination path, branch and current main head from the worker's local-merge view; do not infer them from another clone or the candidate branch.

```yaml
local_merge:
  command_id: CMD-0042-merge-main-01
  action: merge_local_candidate
  run_id: <current delivery run ID>
  request_revision: 2
  candidate_commit: <complete candidate commit from the current review package>
  main_checkout: 'C:\WerkHome\.werk\worker\projects\example\checkout'
  main_branch: main
  main_head: <complete current main commit from the local-merge view>
```

`request_revision` is the accepted semantic input revision, not the mutable journal revision used by CLI `--if-match`. Both Git commit fields must be complete lowercase SHA-1 or SHA-256 identifiers. The path must be the exact absolute assigned checkout, and the branch must be a valid Git branch. Missing/unknown fields or an `operation_id` on a new merge are rejected. A stale candidate/run/revision or dirty/staged/untracked/conflicting main checkout cannot be authorized by editing generated status.

If the outcome is unknown, replace the command with a new command ID and identify the saved operation:

```yaml
local_merge:
  command_id: CMD-0042-observe-main-01
  action: reconcile_local_merge
  operation_id: CMD-0042-merge-main-01
  run_id: <same retained delivery run ID>
  request_revision: 2
  candidate_commit: <same retained candidate commit>
```

Reconciliation uses the saved destination; `main_checkout`, `main_branch` and `main_head` are forbidden on that command. It reads the exact saved Git state and never repeats a merge, resets files or discards work. Repeat an acknowledged command with its identical payload/ID; changed content needs a new command ID.

The confirmed local merge does not push main automatically. Publish/synchronize the resulting main commit before later shared requests can use it as an accepted baseline. Requests prepared against an older baseline must be refreshed/reprepared or replaced to include the accepted increment. Confirmed merge request history is retained in this version so admission-safety evidence cannot disappear; deletion is blocked until a future independent durable project receipt ledger supports safe cleanup. See [the delivery contract](worker-release-workflow.md#explicit-main-checkout-merge).

Commands are durably consumed once. Repeated saves return the prior acknowledgement;
changed content under the same command ID is rejected. Stale candidate, revision
or run targets produce a rejection with the next action to reconcile. UI commands
use these same application rules. Editing generated status cannot accept work.

A delivery's lifecycle is `draft`, `submitted`, `ready`, `in_progress`,
`in_review`, `done` or `cancelled`. Its run status and phase are separate facts.
A completed invocation or successful verification does not establish `done`;
local delivery requires human acceptance of the verified candidate. New
`localMerge: true` policy additionally waits for the explicitly approved main-checkout
merge receipt. Older policies keep their established review-completion behavior.
A Markdown review note does not itself prove a merge or hosting-service PR.

The [local delivery explanation](../explanation/local-delivery-worker.md) describes
the journey and the [acceptance ledger](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reports/2026-10-20-local-delivery-acceptance.md)
records qualification limits. The remaining legacy field and management tables
below describe `schemaVersion: 1` compatibility.

## Shared authoring API

Authenticated `POST /api/features` accepts `action: "prepare"` and
`action: "publish"` when a shared repository is bound. The portable equivalents
are `feature prepare --file command.json` and `feature publish --file command.json`.
Both are authoring operations; only shared intake admits execution.

- `prepare` takes a stable `operationId` and can seed a new template with
  `seed: {title, message, provider, paths}`, reopen `name`, or check edited
  `markdown`. It returns the canonical Markdown, feature ID, filename/path,
  readiness findings, current remote `revision` (null for a new note),
  `workflowDigest` and repository `binding`. It does not invoke a model.
- `publish` takes `operationId`, `name`, `markdown`, `status: "draft" | "ready"`,
  `expectedRevision`, `expectedWorkflowDigest` and `expectedBinding`. Copy the
  guards from preparation. Publishing rechecks the destination, workflow bytes
  and request revision, then commits and pushes only the request note. Ready
  publication additionally requires passing readiness checks.

The result's `publication` identifies the confirmed commit and head. This confirms
Git publication, not a claim or model execution. Retain the exact command and
operation ID after an uncertain response; retrying it reconciles publication.
The developer checkout is preserved. A disabled shared intake still permits
publication, but pauses new claims. Shared-bound workers refuse legacy direct
creation through chat, task or file-task endpoints rather than bypass this queue.

Webview answers and resume requests publish the linked Task response, then use
the same shared Markdown response consumer. Accepted requirements and checks
remain frozen. See the [shared Task contract](shared-feature-intake.md#markdown-communication-contract).

## Automatic task tracking

Every worker task receives an Obsidian-compatible Markdown progress record
linked to its Feature Request automatically. Repository-file permissions and
watched-folder intake are separate choices; neither is required to retain this record. Follow-ups, answers,
continuations and retries use the same session record rather than creating a new
feature request for each model call.

| Worker configuration | Generated record location |
| --- | --- |
| Configured `features.directory` | `<features.directory>/_tasks/fr-<stable-session-hash>.md` |
| No configured feature folder | `<stateDir>/feature-requests/fr-<stable-session-hash>.md` |

The filename uses a stable 24-character session hash. Generated frontmatter marks
`source: worker-tracking` and includes `featureRequestId`, `featureRequestKey`
and `intakeSource`. Folder/shared-source records use `type: FeatureRequestProgress`
so the source note remains the single intake Feature Request; private interaction
and orchestrator projections retain `type: feature-request`. A source path is
retained when available. These files project existing accepted work. They are
not watched intake:
editing them does not submit work, answer a checkpoint or approve completion.

Records separate task status, request phase, gate evaluations, pending input,
recorded outcomes and attempts. A completed model turn is not proof of passed project tests,
applied changes or human acceptance; simulations stay explicit. The webview shows
the confirmed filename and saved time only when synchronization succeeds. Pending
or failed synchronization remains visible and retryable; accepted work stays in
the durable worker journals and must not be duplicated to recover a Markdown
write. The worker retries synchronization automatically.

For workers without a shared repository binding, direct interaction submits
authenticated `POST /api/tasks` with
`{action: "create", id, title, message, provider}`, optional agent selectors, and
optional `files: {repository, paths}`. Replaying the same ID and input returns
the pending preparation or admitted task; changed input conflicts. An admitted
response uses HTTP 200 and contains `{session, chat, featureTracking}`.
Approved-file execution returns its own `local-<id>` session identity; use the
returned ID for subsequent actions. These are the same retained task/patch
contracts used by the compatible CLI commands.

For file requests, add `background: true` to prepare the worktree without holding
the HTTP request open. The unified composer uses this option. HTTP 202 returns:

```json
{"preparation":{"id":"request-id","title":"Request title","repository":"app","state":"preparing","phase":"waiting","error":null,"createdAt":"...","finishedAt":null}}
```

This is in-memory progress, not durable task acceptance. Retain the exact original
command and its ID until the worker returns the admitted session. Poll
`GET /api/taskboard` without resubmitting: `preparations` reports `state`
(`preparing` or `failed`) and `phase` (`waiting`, `worktree` or `admission`).
Once the preparation disappears and the matching ID appears in `tasks`, fetch
`POST /api/tasks {action: "get", id: task.sessionId}` for the normal session,
chat and tracking response. A pending Markdown projection can still be retried
independently after task acceptance.

A failed preparation stops polling and retains its error. An explicit repeat of
the same original create command retries that preparation; polling never retries
it. If restart or disconnection leaves neither preparation nor task visible,
inspect current state and explicitly retry the same command instead of creating
a new identity. Progress receipts themselves do not survive restart.
`POST /api/taskboard/action {action: "cancel", id}` aborts preparation; active
Git work drains before it reports failure. Deleting a preparation is allowed only
after it fails. The compatible legacy `POST /api/taskboard` background request
still returns a taskboard view with `preparationId`; it generates its own ID and
requires the caller to retain its submitted input.

Recovery of interrupted file preparation reuses only an owned pristine worktree
bound to the exact durable command. A changed or unverified checkout is preserved:
creation returns the retained failed session and its tracking state, while the
file task records `admissionFailure.paths`, an empty `files` array, its error and
worktree path. No snapshots or new execution are accepted. Replaying creation
returns that failed identity; execution retry, resume and follow-up commands
conflict. Inspect the preserved checkout, then create a new request to approve
current repository files. The failed record survives restart.

The authenticated `GET /api/feature-tracking` endpoint synchronizes and returns
`{directory, lastSyncedAt, error, records}`. `POST /api/feature-tracking` with
`{action: "get", sessionId}` returns that retained session's saved record plus
`markdown`. Record metadata includes `sessionId`, `taskId`, `filename`, `path`,
`revision`, `updatedAt` and `status`. The existing session view carries the same
confirmed metadata as `records[].featureRequest`, with the synchronization
summary in `featureTracking`. A previous successful record can remain visible
alongside a later sync error; its timestamp is the saved observation, not proof
that current progress has been written.

Generated notes retain bounded activity/outcome excerpts and attempt references;
full execution evidence stays in the worker. They omit approved file contents,
private model dispatch/context and raw patches. Synchronizing these local files
does not itself commit or push them; shared intake keeps its own lifecycle and
review-note publication contract.

## Template and configuration

`worker init` installs `features/_templates/feature-request.md` for **shared Git
intake**. It contains `templateId`, uses the configured provider explicitly and
is authored through `feature author` or the standalone authoring script. Setup
preserves existing templates. It is never admitted by the local watcher.

For the separate **local folder** flow, generate its default template without a
running worker:

```sh
node bin/apps/worker/cli.mjs feature template > features/new-feature.md
```

The local template starts in `draft` and uses the configured feature provider unless
you add a `provider` override. Fill it in and change `status` to `ready` to queue
it. A minimal request is:

```markdown
---
schemaVersion: 1
title: Explain the search design
status: ready
mode: chat
provider: codex-cli
---
# Goal
Explain a search flow for the project.

## Acceptance criteria
- Compare the simplest viable approaches.
- Describe how to verify the selected behavior.
```

The installed `.werk/worker.json` configures the watcher. Its legacy
`features.provider` seeds `defaultProvider` only when no saved default exists;
later provider defaults are edited in the worker settings:

```json
{"schemaVersion":1,"features":{"directory":"features","provider":"codex-cli","pollMs":1000}}
```

`features.directory` enables intake; without it or `--features-dir`, existing
workers do not scan or create an intake feature folder. Automatic task tracking
still uses the worker state directory. Relative paths resolve against
`--project-dir` when supplied, otherwise the working directory. The portable
worker launched from an initialized project discovers `.werk/worker.json`.
`feature folder get` reports the saved path; `feature folder plan --path requests`
previews a relocation; `feature folder set --path requests` persists it and moves
existing requests/results while the project worker is stopped. The destination
must be a new, separate folder inside the project. See the
[folder configuration guide](../how-to/project-worker.md#choose-or-change-the-feature-folder).
`--features-dir requests` overrides its folder for a launch. Polling supports Docker bind mounts
and editor atomic saves; a new request must be unchanged across two observations.
The configurable interval is 250–30,000 ms, default 1,000 ms. Only files directly
inside the configured folder are ingested; subfolders and underscore-prefixed
files are reserved/ignored.

## Request fields

This table describes local folder intake. Shared requests additionally require
explicit ready status, ID, template ID and patch mode; see the
[shared contract](shared-feature-intake.md#request-and-template-contract).

| Field | Contract |
| --- | --- |
| `schemaVersion` | Required integer `1`. |
| `title` | Required, 1–120 characters. |
| `status` | `draft` holds a new request. Explicit `ready` submits it once stable; an omitted status does not submit new work. After capture, the worker owns this field. |
| `id` | Optional stable identifier, 1–80 lowercase letters/digits/hyphens, starting with a letter/digit. The worker assigns one when absent. Do not reuse IDs for different work; `remote-` is reserved. |
| `mode` | `chat` (default) sends the Markdown as a task message. `patch` generates a review patch from explicitly approved files. |
| `provider` | `codex-cli`, `claude-cli`, `openai-api`, `anthropic-api` or `cursor-cli`; omission uses the saved worker `defaultProvider`. Configure/authenticate that connection separately. |
| `model` | Optional model name, at most 200 characters with no surrounding whitespace or control characters. A nonempty value overrides a compatible instruction-profile model and then the provider's default; omission or an empty string inherits. |
| `effort` | Optional [provider-supported effort](model-interaction.md#provider-model-and-effort-selection). Omission inherits the worker's provider default; explicit `default` uses the provider's own behavior. Cursor supports `default` only. |
| `paths` | Required for patch mode: up to 32 project-relative approved text files or, for implementation, folders ending in `/`. Rejected in chat mode. |
| `priority` | `1` or `2` (default `1`); applies to patch tasks when the taskboard uses priority ordering. |
| `definitionRef` or `definitionId`, `agent`, `useInstructionsOnly` | Optional [Docker Agent instruction profile](agent-definitions.md) selection, with the same compatibility acknowledgement as the webview. Use `definitionRef` (1–80 lowercase letters, digits or hyphens) in committed or shared files: it names a definition by its [stable reference](agent-definitions.md#stable-references-for-committed-requests). `definitionId` is specific to one worker. A request may use one, not both. |
| `source`, `werk` | Worker-owned provenance and lifecycle metadata. Orchestrator files use `source: orchestrator`; users must not create remote assignments by editing this field. |

Custom frontmatter fields/comments are retained. The user-owned Markdown body is preserved
when lifecycle metadata is written; canonical delivery updates its designated region. The whole document is bounded to 64 KiB;
local request Markdown is bounded to 8,000 characters. YAML aliases, custom tags,
duplicate keys, unsafe mapping keys and excessive depth/nodes are rejected.
Invalid files stay untouched and appear in `_worker-status.md` and `feature list`.

For a patch request, use `mode: patch` and, for example, `paths: [src/search.ts]`.
In an assigned Git repository the worker captures committed input in an isolated
worktree; uncommitted developer changes are excluded. Non-Git local requests use
bounded approved-file snapshots. Proposal-only execution produces a patch for
review. With configured implementation tools and required checks, the worker can
apply approved changes in the task worktree and run those checks; inspect its
recorded evidence. Shared intake can publish a feature branch after its done
rules pass. Human review/merge remains separate. Chat does not discover files
without separately granted tools. Both modes may consume subscription/API usage
when admitted; importing a draft does not invoke the model.

### Approved file paths

File tasks, local feature folders, shared Git intake, offline authoring and the
live Codex `allowedPaths` setting use the same rule for approved paths.

- Paths are relative and use `/` as the separator.
- Names may use letters, digits and combining marks in any script, such as
  `ä ö ü Ä Ö Ü ß é 日本`.
- Names may also use spaces and these characters: `_ . - , ( ) & ' ’ + – — →`.
- The worker stores and compares paths in Unicode NFC form. A decomposed spelling,
  such as one typed on macOS, is converted to NFC, and two spellings of one name
  count as a duplicate.
- A path is at most 240 characters. Each segment is at most 255 UTF-8 bytes.

The worker rejects these paths:

- `.` or `..` segments, empty segments, and absolute paths.
- Paths that start with `-`.
- Dot-prefixed files or folders, such as `.env` or `.werk/…`.
- Segments that end in a dot or a space, because Windows silently removes them.
- Windows device names such as `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9` and
  `LPT1`–`LPT9`, with any extension, such as `nul.md`.
- Control and invisible formatting characters.
- Windows-reserved characters: `< > : " | ? *` and `\`.
- Shell, glob and wiki-link characters such as `$`, `` ` ``, `~`, `[`, `]` and `#`.
- Credential or secret file names (`credentials`, `secrets`, `id_rsa`,
  `id_ed25519`) and private-key extensions (`.pem`, `.key`, `.p12`, `.pfx`). These
  checks also cover look-alike spellings, such as full-width letters.

Example of an accepted path:
`docs/requirements/FA-9_Material-Logistics/LACF-REQ-033 Warenein- und -ausgang einschließlich Zoll abwickeln.md`.

#### Folder entries

An entry that ends in `/`, such as `src/frontend/src/app/features/auftrag/`,
approves a folder. File tasks, local feature folders, shared Git intake and offline
authoring accept folder entries; the live Codex `allowedPaths` setting does not.

- A folder entry follows the same rules as a file path, without the final `/`. The
  repository root (`/`) and folders such as `.git/`, `.github/` or `config/secrets/`
  are rejected.
- The 32-entry limit counts folder and file entries together.
- A folder and a file, or two folders, must not differ only by letter case or
  Unicode normalization. A file may have the folder's name only in one form.
- A folder entry requires an implementation request: an assigned Git repository,
  repository file access and at least one required verification check. A proposal
  request refuses it.
- The implementation may create, change and delete files below the folder. A file
  below it is approved only when its own path follows the file rules above; for
  example `auftrag/.env` or `auftrag/secrets.json` stays unapproved, and a change to it
  fails the candidate.
- The initial snapshot records a folder entry without file contents. The model reads
  files with its granted tools.
- Shared intake refuses a folder that contains, or lies within, the request, review or
  task folders or another protected workflow file.

YAML gives some characters special meaning, so write paths that contain them as
a block list:

```yaml
paths:
  - docs/requirements/LACF-REQ-101 Angebote prüfen, freigeben & versenden.md
  - "docs/Kunden's Änderungen (Größe).md"
```

In flow style, `paths: [a, b.md]`, a comma separates two paths. Quote a name that
contains a comma, or one that starts with `&`, `'` or `"`.

A file task refuses a path when an existing file or folder has the same name in a
different Unicode normalization. Rename that file to its composed (NFC) spelling
first. Otherwise the patch would create a second file that looks identical.
Shared publication refuses a new file that differs from a tracked file only by
letter case or Unicode normalization.

Patches quote every path in Git's C-style form, which `git apply` accepts.

## Lifecycle and recovery

The worker writes `id`, `status` and a `werk` mapping containing `source`, `taskId`,
`sessionId`, `submittedAt`, `updatedAt`, `inputHash`, result references and any
current admission error. It saves accepted input in private state before dispatch.
Queue submission is idempotent by task ID, including recovery after an interrupted
acknowledgement.

| Status | Meaning |
| --- | --- |
| `draft` | User is still writing; not captured or submitted. |
| `waiting` | Captured durably, waiting for admission, provider configuration or queue capacity. See `werk.error` when present. |
| `queued` | Accepted into the worker's existing queue. |
| `running` | Executing in the worker's single shared slot. |
| `completed` | Chat/assignment finished; inspect its result for actual outcome. A simulated assignment remains explicitly simulated in the result. |
| `review` | A patch is ready for human review. |
| `failed`, `cancelled` | Execution failed or was stopped; it is not automatically replayed. |
| `unsaved` | The task reports a persistence failure; inspect private state before retrying. |
| `unavailable` | Linked task history was removed; the request is not resubmitted. |

Readable results are under `_results/<id>.md`; local patches are under
`_results/<id>.patch`. `_worker-status.md` summarizes tracked requests and intake
errors. The files show the last synchronized observation; stop/restart and polling
can delay updates. `feature list` (authenticated `GET /api/features`) additionally
reports watcher faults. Protected environment data includes the same watcher view.

## Per-execution evidence

Once a task starts executing, `werk.execution` identifies that specific run and
links its before snapshot. When execution finishes, it also links its after
snapshot and immutable result. The stable request ID, task ID and session ID do
not change on retry; `runId` changes and `attempt` increments for each reserved
execution in that session. A request waiting for provider setup or capacity has
no execution snapshot. Queued work cancelled before execution exports no
before/after execution pair. Its private run ledger can retain a terminal
observation labeled `cancellation`; this does not represent model execution.

`werk.executionDirectory` points to `_results/<feature-id>/`. This directory
retains artifacts for executions observed by the feature watcher:

| Artifact | Contents |
| --- | --- |
| `<run-id>.before.json` | Run/request identity and the worker-process resource and cumulative-consumption snapshot taken at execution start. |
| `<run-id>.after.json` | The same snapshot schema at completion or recovery, plus reported usage, execution duration and queue duration when available. |
| `<run-id>.md` | The immutable readable result for a completed execution pair. |
| `<run-id>.patch` | The patch produced by that run, when present. |

A cancelled or interrupted execution can have incomplete measurements. Inspect
snapshot state and resource measurement scope before comparing runs. Resource
samples describe the Node worker process; they do not measure the provider
subprocess, model service or project test runner. Cumulative consumption includes
field-level coverage. Missing token counts, cost or duration remain `null`, rather
than zero. Provider-reported cost is recorded only when the provider reports it;
configured subscriptions do not establish cost or quota.

The existing `_results/<feature-id>.md` and `.patch` paths remain convenience
exports for the latest finished result. On retry or follow-up, current result and
patch pointers are removed until new work finishes. Previously exported run artifacts remain
in the execution directory. Archive/restore and watcher polling do not rewrite
those immutable run artifacts. Conflicting evidence is reported as a watcher
fault and remains available for inspection.

The JSON exports contain execution identity, status, resources and usage. They
exclude request bodies, model replies, approved-file content and credentials.
Readable result/patch files can contain project content and retain their existing
access and retention requirements. A fast direct task retry can finish and start again between watcher polls.
Feature retry captures the finished run before resubmitting when it is still
available, but folder exports are an observed lifecycle view. The durable run
ledger is authoritative for all admitted executions; use its run export commands
for complete history. For comparisons over many runs, use the worker's
execution evidence and analysis commands described in the
[portable apps reference](portable-apps.md); orchestrator snapshot history remains
a separate evidence scope.

Changing or deleting an accepted file does not change/cancel its captured task.
Renames retain identity through `id`. Changed input is flagged with
`werk.inputChanged`; create a new filename, remove `id`/`werk`, and use `status:
ready` for different work. Duplicate IDs are reported and not newly admitted.
Worker writes are atomic and check the observed revision before replacement;
avoid editing the worker-owned fields while it synchronizes.

Waiting requests survive restart. Accepted patch tasks preserve the existing
queued-task recovery behavior. Interrupted execution and stopped/queued Chat
turns are marked failed/cancelled rather than silently replayed. Use the existing
`task send`/`task cancel` or `file-task action` CLI with the recorded task ID for
explicit follow-up, cancellation or patch retry; no webview is required. Retry
uses saved input, so create a new request when approved files must be recaptured.

Each orchestrator assignment gets `remote-<task-id>.md` before worker acceptance.
Its criteria, attempt, session and outcome stay visible there. Remote files never
enter local intake; the orchestrator retains lease, routing and retry authority.
An exported assignment is a tracking record, not a second queued execution.

## Ownership and limits

One feature folder belongs to one worker state. `_worker-owner.json` prevents
accidental consumption by another worker; `_worker.lock` prevents concurrent
writers. Move/back up private state and its feature folder together. After a crash,
verify that the old process is stopped before removing stale worker/folder locks.
Deleting owner metadata to reuse a folder is not a supported migration.

The folder and private index hold at most 1,000 request records; active queue and
100-session/taskboard limits still apply. Use a fresh worker state/folder for a
new long-running project phase once the index is full. Results and request bodies
can contain project information: apply the project's access/retention policy.
Setup adds ignores for private state, provider home, generated results and watcher
coordination files while keeping request Markdown/templates available to Git.
Symlinked request files, feature directories and result directories are refused.


## CLI management contract

The local management commands below use the authenticated worker API and require
a running worker with a configured feature folder, except `feature template` and
local `feature folder get|plan|set`. A saved shared repository binding suspends
local admission and mutations. Connected shared authoring uses `feature prepare`
and `feature publish` with the guarded API contract above. Offline authors use
`feature author create|validate|ready` or the committed authoring script without
a worker connection; they commit and push through their own Git workflow.
Use `schema` for command discovery. Output is JSON; `feature template` emits
Markdown. In Docker, prefix commands with `docker compose -f
.werk/compose.worker.yaml exec -T worker` and run the same Node CLI inside it.

| Command | Required options and behavior |
| --- | --- |
| `feature list` | Includes tracked `records`, current `files` (including drafts), watcher errors and faults. Optional `--status STATUS`, `--archived true\|false`. |
| `feature create` | `--name NAME.md --markdown PATH\|-`. Imports a validated draft; refuses an existing or retained filename. |
| `feature get` | `--name NAME.md`. Returns original Markdown, SHA-256 `revision`, and the linked record when accepted. Invalid files remain readable for repair. |
| `feature validate` | `--name NAME.md`. Validates stored frontmatter/body without submitting. For a request that is not yet accepted, it also resolves `definitionRef`/`definitionId` on this worker and fails with `invalid_input` when the reference is unknown, the agent is missing, the profile needs `useInstructionsOnly: true` or its provider does not match. |
| `feature edit` | `--name NAME.md --markdown PATH\|- --if-match REVISION`. Replaces an unaccepted draft, preserving supplied Markdown bytes. Can repair malformed files. |
| `feature submit` | `--name NAME.md --if-match REVISION`. Marks the validated draft ready; the watcher reserves and admits it. Inspect `waiting` errors if capacity/provider setup prevents admission. |
| `feature cancel` | `--name NAME.md --if-match REVISION`. Cancels a waiting reservation or its local chat/patch task. Running cancellation is asynchronous. |
| `feature retry` | `--name NAME.md --if-match REVISION`. Retries a cancelled reservation or failed/cancelled local task in its existing session. Waiting reservations already retry admission automatically. |
| `feature result` | `--name NAME.md`. Returns current execution status, text and patch when retained. |
| `feature wait` | `--name NAME.md [--timeout-ms N]`. Polls until completed/review/failed/cancelled/unavailable. Default 60 seconds, maximum 24 hours. |
| `feature archive`, `feature restore` | `--name NAME.md --if-match REVISION`. Sets `werk.archived` on a stopped request; does not delete evidence or archive its session. |
| `feature delete` | `--name NAME.md --if-match REVISION`. Removes a draft, malformed file, or stopped request file. Retains accepted task identity, session and exported results; never deletes active work. |

Read the current revision immediately before an edit or lifecycle mutation. A
stale revision returns an input/API rejection (exit 2); reread and reconcile.
These checks coordinate with the watcher and other CLI callers. External editors
do not participate in that lock: avoid concurrent saves during CLI mutations.
Legacy accepted snapshots remain immutable. For unrelated work, create a new draft
with a new filename/ID and no `werk` or `source` fields. Canonical local delivery
reassesses material changes to the same request; terminal requests need explicit reopen. Feature files can still be renamed
in the filesystem: their durable ID preserves identity on the next scan.

`feature wait` returning successfully means a terminal state was observed, not
that the model succeeded: automation must inspect the returned execution status.
A wait timeout exits 1 and leaves the task running. Orchestrator-owned feature
records support inspection, validation and waiting; mutations are rejected with
instructions to manage the assignment through its orchestrator.

Chat retry resends the last user message in the existing conversation. Patch retry
uses the original captured files. Neither creates a second session. Archive/delete
never removes the private deduplication record or frees its 1,000-record limit.
Use `task delete` and `file-task delete` explicitly to clean retained task history;
requests whose history has been removed become `unavailable`, without replay.

## Questions and explicit continuation

A local chat or approved-file task can enter `waiting_input` (a question) or `escalated` (an operator decision). It releases the execution slot while waiting. The worker preserves the accepted request body, approved file snapshots and frozen provider configuration.

For local folder requests, the linked question at
`_questions/<feature-id>/<pending-id>.md` now uses `type: Task` and is discoverable
through `werk.task`. Write the actual
answer under `## Answer` and set `status: ready`. After a stable local save the
worker validates the generated identity/revision and calls the guarded interaction
answer. No Git push is required for this local flow. Supported failed/interrupted
latest turns get resume Tasks under `_tasks/<feature-id>/`; cancelled turns do not.
Informational `attention.md` Tasks with `status: blocked` explain held gates or
unsupported recovery and cannot be executed by editing them. The original request
links the current diagnostic through `werk.attention`, clearing that link when
the hold resolves; retained notes are historical checkpoints. Copying a Task or
PullRequest companion into the intake root cannot create a new feature request.

Local patch result notes under `_results/<feature-id>.md` use `type: PullRequest`
as the human review handoff. These files and the generic automatic tracking notes
remain evidence projections, not response commands. Older question companions
without the actionable Task contract remain historical; editing them does not
answer a live checkpoint.

For shared requests, use their `werkTask` link and **commit and push** the ready
Task response. The local watcher never ingests shared `templateId` requests or
their responses. The [shared Task contract](shared-feature-intake.md#markdown-communication-contract)
defines identity checks and remote acknowledgement.

The UI, CLI and API remain equivalent guarded interaction controls. They require
the current revision, pending/turn identifier and a unique operation ID. Repeating
the same operation reconciles acknowledgement; stale decisions are rejected.
Answers queue a new measured invocation using saved context. Restart preserves
unanswered checkpoints and known results without automatically replaying inference.
Orchestrator assignments retain their lease and routing boundaries. Handle all
question/result files with the same privacy care as their feature requests.

For legacy intake, a genuine failed, cancelled, or interrupted attempt may use guarded feature retry when its frozen readiness verdict still passes. Gate-held requests and known completed results require the request controls instead. Retry also checks the generated request ID, revision, input revision, and policy digest against the canonical worker record. If admission succeeded but saving its acknowledgement failed, the old file revision cannot dispatch again: inspect `feature get`, refresh the generated projection, and reconcile before another intentional retry.
