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
`--features-dir requests` overrides its folder. Polling supports Docker bind mounts
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
| `definitionId`, `agent`, `useInstructionsOnly` | Optional [Docker Agent instruction profile](agent-definitions.md) selection, with the same compatibility acknowledgement as the webview. |
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
