# Markdown feature requests

A worker can use a configurable project folder as a file-based intake and lifecycle
view. Each request is one UTF-8 `.md` file with YAML frontmatter and a Markdown
body. The worker's existing serial executor owns the work; watching a folder does
not add a parallel model process. See [project setup](../how-to/project-worker.md).

## Template and configuration

`worker init` installs `features/_templates/feature-request.md`. Customize it;
repeating setup preserves it. Generate a fresh default without a running worker:

```sh
node bin/apps/worker/cli.mjs feature template > features/new-feature.md
```

The template starts in `draft` and uses the configured feature provider unless
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

The installed `.werk/worker.json` configures the watcher:

```json
{"schemaVersion":1,"features":{"directory":"features","provider":"codex-cli","pollMs":1000}}
```

`features.directory` enables intake; without it or `--features-dir`, existing
workers do not scan or create a feature folder. Relative paths resolve against
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

| Field | Contract |
| --- | --- |
| `schemaVersion` | Required integer `1`. |
| `title` | Required, 1–120 characters. |
| `status` | `draft` holds a new request. `ready` or an omitted status submits it once stable. After capture, the worker owns this field. |
| `id` | Optional stable identifier, 1–80 lowercase letters/digits/hyphens, starting with a letter/digit. The worker assigns one when absent. Do not reuse IDs for different work; `remote-` is reserved. |
| `mode` | `chat` (default) sends the Markdown as a task message. `patch` generates a review patch from explicitly approved files. |
| `provider` | `codex-cli`, `claude-cli`, `openai-api` or `anthropic-api`; defaults to `features.provider`. Configure/authenticate that connection separately. |
| `paths` | Required for patch mode: up to 32 project-relative approved text files. Rejected in chat mode. |
| `priority` | `1` or `2` (default `1`); applies to patch tasks when the taskboard uses priority ordering. |
| `definitionRef` or `definitionId`, `agent`, `useInstructionsOnly` | Optional [Docker Agent instruction profile](agent-definitions.md) selection, with the same compatibility acknowledgement as the webview. Use `definitionRef` (1–80 lowercase letters, digits or hyphens) in committed or shared files: it names a definition by its [stable reference](agent-definitions.md#stable-references-for-committed-requests). `definitionId` is specific to one worker. A request may use one, not both. |
| `source`, `werk` | Worker-owned provenance and lifecycle metadata. Orchestrator files use `source: orchestrator`; users must not create remote assignments by editing this field. |

Custom frontmatter fields/comments are retained. The Markdown body is preserved
when lifecycle metadata is written. The whole document is bounded to 64 KiB;
local request Markdown is bounded to 8,000 characters. YAML aliases, custom tags,
duplicate keys, unsafe mapping keys and excessive depth/nodes are rejected.
Invalid files stay untouched and appear in `_worker-status.md` and `feature list`.

For a patch request, use `mode: patch` and, for example, `paths: [src/search.ts]`.
The worker snapshots only those files from the project working directory. It
produces a patch for review; it does **not** apply changes or run project tests.
Chat does not discover project files. Both modes use configured providers and may
consume subscription/API usage when admitted; importing a draft does not prompt.

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

All feature-management commands use the authenticated worker API and require a
running worker with a configured feature folder, except `feature template` and the local `feature folder get|plan|set` commands.
Use `schema` for command discovery. Output is JSON; `feature template` emits
Markdown. In Docker, prefix commands with `docker compose -f
.werk/compose.worker.yaml exec -T worker` and run the same Node CLI inside it.

| Command | Required options and behavior |
| --- | --- |
| `feature list` | Includes tracked `records`, current `files` (including drafts), watcher errors and faults. Optional `--status STATUS`, `--archived true\|false`. |
| `feature create` | `--name NAME.md --markdown PATH\|-`. Imports a validated draft; refuses an existing or retained filename. |
| `feature get` | `--name NAME.md`. Returns original Markdown, SHA-256 `revision`, and the linked record when accepted. Invalid files remain readable for repair. |
| `feature validate` | `--name NAME.md`. Validates stored frontmatter/body without submitting. |
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
Accepted input is immutable. To request different work, create a new draft with a
new filename/ID and no `werk` or `source` fields. Feature files can still be renamed
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

The request’s worker-owned `werk.interaction` metadata exposes `phase`, `revision`, and, while pending, `pendingId` and a `link` to `_questions/<feature-id>/<pending-id>.md`. The companion records the question, choice identifiers and escalation reason. It is a historical projection: it can remain after resolution, and editing it never answers the task. Read current interaction state before acting.

Answer or resume through the worker’s unified interaction controls (UI, CLI or API), supplying the current revision, pending/turn identifier and a unique operation ID. The same operation can be retried safely; a stale decision is rejected. Answering queues a new measured run using explicit worker-context replay, rather than a hidden provider-session resume. Failed or interrupted continuations require explicit resume. Restart preserves unanswered checkpoints and reconstructs known valid patch results without another provider call. Orchestrator-owned assignments retain their orchestrator lease and routing boundaries.

Question companions contain request-specific content; handle them with the same privacy care as feature requests and result artifacts. Numeric before/after evidence remains separate.

A genuine failed, cancelled, or interrupted attempt may use guarded feature retry when its frozen readiness verdict still passes. Gate-held requests and known completed results require the request controls instead. Retry also checks the generated request ID, revision, input revision, and policy digest against the canonical worker record. If admission succeeded but saving its acknowledgement failed, the old file revision cannot dispatch again: inspect `feature get`, refresh the generated projection, and reconcile before another intentional retry.
