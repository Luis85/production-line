# Worker–model interaction contract

The local worker owns prompt state and continuation. The adapter translates a
versioned request to a supported provider and returns a typed result. This contract
covers local Chat, approved-file tasks and their feature requests. Original remote
orchestrator executions retain their lease and execution authority. The unified
webview composer exposes optional approved-file permission without changing these
execution contracts. Every task also has a generated Markdown progress record;
follow-ups and checkpoints update it without replacing authoritative source notes
or the private journal. See [automatic task tracking](feature-requests.md#automatic-task-tracking).

## Capabilities and dispatch

Use `capabilities` in the portable worker CLI to inspect the wrapper contract.
Its original `capabilities` field remains the version 1 baseline; additive
`modelSessions` metadata describes version 2 profiles, recovery and delegation.
Inspect a saved dispatch for the actual invocation profile. The current adapters
expose structured questions through Werk protocol
version 1 and report usage when the provider supplies it. New Feature Request
sessions use dispatch schema version 2; retained version 1 dispatches remain
supported. Claude CLI and Cursor CLI sessions declare
`continuation: provider_session` and `nativeResume: true`.
Codex CLI and direct API sessions declare
`continuation: worker_context_replay` and `nativeResume: false`. All currently
report `streaming: false`; durable interaction events remain available.
Capabilities describe the configured invocation, including its tool manifest.
The read-only `werk_session_history` tool is bound to the current Feature
Request. Other Werk tools require operator grants. Cursor declares
`tools: provider_native` and `filesystem: provider_permissions`; its native policy
is described [below](#cursor-native-execution). An invocation with a catalog
records `tools: granted` and its public tool manifest. Optional `limits` metadata
records the accepted call count, total invocation duration (`windowMs`) and
resolved tool/preset deadlines. This is execution evidence, not a separate
tool-policy window. These capabilities describe the wrapper, not everything the
provider brand or its other SDKs can do.

`ModelRequest` contains its schema/protocol version, chat or patch operation,
provider ID, model, effective instruction, messages, capability/policy snapshot,
protocol instructions and rendered semantic prompt. The worker saves this private
dispatch and its digest before invoking the model. Granted invocations include
the tool-policy revision, names, descriptions and input schemas. This snapshot
is evidence, not authority: execution requires the current matching grant. It
excludes API keys, bearer headers, process environment and hidden model state.
It is not a wire capture.

A continuation uses the saved prompt configuration. Current credentials can be
resolved privately to contact the same provider; editing settings must not silently
rewrite an accepted instruction or model identity. A new follow-up, answer or
resume attempt captures current execution limits when its dispatch is prepared.
Execution of an already prepared dispatch keeps that dispatch's frozen budget. Patch continuation preserves
the approved file snapshots. Existing proposal tasks return patch JSON without applying it.
New eligible repository requests additionally freeze an implementation scope and required
verification plan: the model edits only approved paths in the isolated worktree,
runs the required checks and returns a readable summary. The worker captures the
actual candidate patch and verifies matching check receipts before review. The
developer checkout is not edited. Continuations use current tool grants; old dispatch evidence
cannot restore revoked access. New limit metadata must match the resolved
catalog and accepted execution budget. Legacy dispatches without this metadata
remain supported only when their policy revision and exact definitions still
match; absence cannot restore a larger budget. Codex, Claude and API request
reviewers have no tools. Cursor reviews use native read-only ask mode and retain
Cursor's permission/hook boundary.
See [manage model tools](../how-to/manage-model-tools.md) for scope, MCP connections
and revocation.

## Provider, model and effort selection

New Feature Requests may select `provider`, `model` and `effort` through Markdown,
the webview or the corresponding authoring/task command. Omitted `provider` uses
the worker's saved `defaultProvider`. An explicit provider is never silently
replaced by another connection when authentication or model selection fails.

The effective model is selected in this order:

1. The request's nonempty `model` override.
2. The selected compatible instruction profile's model.
3. That provider connection's configured default model.

A blank model inherits before acceptance. For CLI providers, an empty resolved
model means the CLI chooses its default; it is not evidence of a specific observed
model name. Model names are at most 200 characters, without surrounding whitespace
or control characters. A supported provider selection does not establish that its
account can use the requested model.

Effort uses the request's explicit `effort`, otherwise the selected provider's
saved default effort. Explicit `default` asks the provider to choose its own
behavior instead of inheriting a non-default worker setting. The wrapper accepts:

| Provider | Effort values |
| --- | --- |
| Codex CLI | `default`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| Claude Code CLI, Anthropic API | `default`, `low`, `medium`, `high`, `xhigh`, `max` |
| OpenAI API | `default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| Cursor CLI | `default` only |

These are provider-level choices. A selected model can support fewer values;
provider errors remain visible rather than being silently retried at another
model or effort. Cursor's adapter does not invent a reasoning-effort flag.

Provider, effective model and effort freeze when the worker accepts the request,
including before a configured Ready Check. Answers, follow-up review generations,
implementation, continuations and restart recovery retain that selection.
Changing worker defaults affects new requests only. Use a new Feature Request to
change an owned request's provider, model or effort. Credentials can still be
resolved privately without replacing the accepted execution identity.

See [choose request defaults](../how-to/use-worker-webview.md#choose-provider-model-and-effort)
for the UI and [settings fields](configuration.md#worker-provider-defaults)
for their configuration location.

### Cursor native execution

The `cursor-cli` adapter invokes the installed Cursor CLI and its native policy.
It does not use the Cursor SDK. Native tools, hooks, MCP connections and subagents
are controlled by the operator's Cursor configuration, not Werk's tool catalog.
Werk supplies no force, auto-approval, workspace-trust or sandbox-override flag
and does not rewrite user or repository Cursor configuration.

Chat, proposal and Ready Check invocations use `--mode ask` in a private worker
workspace. This is Cursor's read-only mode; it does not promise that native tools
or hooks are disabled. An implementation invocation uses the worker's retained
candidate worktree. Werk inspects the resulting candidate and runs its configured
required checks after Cursor returns; native test claims alone supply no verified
completion evidence. The approved published patch and human-review boundary still
apply, while native access during execution follows Cursor's policy.

Granted Werk tools and scoped history can be offered through an invocation-local
private plugin/MCP bridge. Cursor does not receive `werk_delegate`; its subagents
use Cursor's native policy only. Cursor's own MCP approval rules still apply. Worker
grants, revocation and call/command limits govern those supplemental tools only;
they do not bound Cursor native tool calls, hooks or native subagents. The overall
worker execution deadline and managed process ownership remain in force.

The worker creates a native chat, persists its exact identifier before model
execution and resumes only that chat for the accepted Feature Request. An uncertain
result fences replay until explicit recovery. Cursor's configured model is passed
through `--model`; only default effort is supported. The adapter reports usage as
unknown, including native subagents, and does not interpret undocumented counters
as verified tokens or cost. Consumption limits retain the normal unverified-usage
hold rather than treating missing measurements as zero.

See [Cursor setup](../how-to/use-worker-webview.md#connect-cursor-cli) and the
official [permissions](https://cursor.com/docs/cli/reference/permissions),
[hooks](https://cursor.com/docs/hooks) and
[CLI parameters](https://cursor.com/docs/cli/reference/parameters).

## Typed results

New implementation dispatches carry `policy.development: true`; only the private
accepted task scope authorizes candidate tools. They also freeze the candidate source
limits `candidateSourceMaxBytes`, `candidateSourceMaxFiles` and `candidateFileMaxBytes`
in `policy` and record them as `toolManifest.limits.candidateInspection`. The approved
content limits `candidateApprovedFileMaxBytes`, `candidateApprovedTotalMaxBytes` and
`candidateReviewPatchMaxBytes` are frozen the same way and recorded as
`toolManifest.limits.candidateReview`; the `werk_candidate_apply` content schema states
the frozen per-file limit. Approved entries ending in `/` approve safe files below
that folder; `werk_candidate_apply` addresses such a file by its full path, with
`expectedHash: null` when it does not exist yet.
Delegated candidate tools retain the parent's frozen manifest evidence. Only an
implementation child also carries these fields in `policy`; a status/check-only
child does not gain edit authority. Dispatches without candidate tools omit the
candidate inspection metadata. `maxToolCalls` and `commandTimeoutMs`
freeze with the total invocation duration and propagate through API loops and CLI
bridges. Defaults remain 128 calls, a 300-second command ceiling and six hours
total. Optional command/CLI/check timeouts can shorten that ceiling; MCP calls
default to 30 seconds with separate per-connection limits. Remaining invocation
time and cancellation cap every call. Required-check fingerprints bind explicit
timeout overrides. The CLI bridge derives provider MCP waits from the trusted
accepted duration, not mutable manifest metadata. Codex and Claude provider-native
editing and shell tools remain disabled. Cursor follows the native boundary
above. See
[implement a feature](../how-to/implement-feature.md) for configuration.

A model invocation returns completed content or a blocking input request. Legacy
plain-text answers and the existing patch JSON remain supported; the worker does
not infer questions from punctuation. For a question, the model returns exactly:

```json
{
  "werkInteraction": {
    "schemaVersion": 1,
    "kind": "question",
    "message": "Should failed checkouts retry automatically?",
    "choices": [
      {"id": "retry", "label": "Retry automatically"},
      {"id": "manual", "label": "Require manual retry"}
    ]
  }
}
```

Use `kind: escalation` when the request needs an operator decision outside the
supplied authority. `reason` can explain the blocker; choices are optional. One
blocking question is supported per invocation. It may contain a multipart prompt
for a free-text answer. The worker generates its stable pending ID; a model cannot
choose that ID or grant additional capabilities through an answer.

Unknown envelope fields, versions, malformed choices and invalid bounds fail
validation. A malformed envelope is not accepted as a patch. Provider refusal,
incomplete output, authentication, quota/rate limit and protocol failures remain
separate safe error categories where the adapter can identify them. No raw error
body or credential is needed in the public status.

## Approved-file proposal replies

This format applies to snapshot-based proposals. Verified candidate implementations
use the candidate tools and return a plain-text summary after required checks pass.

A proposal asks for one JSON object and states these limits in its prompt:

```json
{"summary": "What changed and which checks ran", "files": [{"path": "approved/path.md", "content": "complete new file text"}]}
```

| Rule | Limit |
| --- | --- |
| Whole reply | At most 64,000 characters |
| `summary` | Text, at most 2,000 characters |
| `files` | 1 up to the number of approved paths; each approved path at most once |
| `content` | The complete new file text, at most 64,000 characters, no NUL character |
| Review patch | At most 131,072 characters, with no private key or access-token pattern |

The worker reads a bare object or an object in a Markdown fence. Prose before or
after it is tolerated when the reply contains exactly one object with `summary`
or `files`; two different such objects are refused as ambiguous. Extraction also refuses replies
that exceed its 256-candidate search bound instead of accepting an unexamined tail. Every rule above
is still checked before the reply becomes reviewable.

The review patch is a Git unified diff with three lines of context per hunk.
Unchanged files are omitted, paths are always quoted so non-ASCII names apply with
`git apply`, and a missing final newline is marked as Git does. A file with more
than 2,000 changed lines is shown as a full replacement.

A reply that breaks a rule fails the attempt without a durable completed result.
The task error starts with `The model reply did not follow the patch format:` and
names the rule and the measured value, never reply or file content. The interaction
turn and its `failed` event carry a matching error code:

| Code | Cause |
| --- | --- |
| `patch_reply_too_large` | The reply exceeds 64,000 characters |
| `patch_reply_not_json` | No JSON patch object was found |
| `patch_reply_ambiguous` | More than one different patch object was found, or bounded extraction could not examine the whole reply |
| `patch_summary_invalid` | `summary` is missing, not text or too long |
| `patch_files_invalid` | `files` is missing, empty, too long or has a non-object entry |
| `patch_file_unapproved` | An entry names a path outside the approved list (shown quoted and shortened) |
| `patch_file_duplicate` | An approved path is listed twice |
| `patch_file_content_invalid` | `content` is not text, too long or contains NUL |
| `patch_unchanged` | Every listed file equals its snapshot |
| `patch_too_large` | The generated review patch exceeds 131,072 characters |
| `patch_sensitive_material` | The patch looks like it contains a private key or token |

Resume the task from saved context to let the model correct its reply.

## State and ownership

| Phase | Meaning and next action |
| --- | --- |
| idle | No managed interaction exists yet |
| queued / running | A durable intent is waiting for or holding the execution slot |
| waiting_input | A structured question is saved; answer its pending ID |
| escalated | An operator decision is saved; inspect the reason and respond |
| completed | A model result is durably accepted; patch review remains separate |
| failed / cancelled / interrupted | Inspect the latest checkpoint and explicitly resume if appropriate |

Waiting ends the model invocation and releases the execution slot. It has no live
model process waiting indefinitely for a human. The completed invocation retains
its own usage and before/after evidence with a waiting/escalated outcome; an answer
starts a new invocation in the same session.

Accepted request input remains immutable. A question is projected on its owning
Feature Request through worker-managed metadata and companion content. For
shared Git intake, answer the generated Task note and mark it ready, then commit
and push to the configured shared branch. The worker validates the saved question
identity and revision before resuming. CLI and webview answers use the same
owning workflow. Editing the original Feature Request body or a progress
projection is not an answer to a pending question. See
[answer and resume](../how-to/answer-and-resume-worker.md).

## Windows command runtime preparation

The worker prepares its contained command launcher in the background while its
HTTP interface starts. Private state and read APIs are initialized first; repository
synchronization and local model dispatch wait until command setup settles. Saved
chat requests and Markdown notes remain durable while the UI shows preparation
progress. Native actions such as manual sync return a retryable unavailable status.
Trusted remote simulations can continue through the same execution permit; they
still obey the saved pause, capacity and cancellation controls.

This trusted setup has a separate 45-second ceiling; it does not run a provider or
establish authentication. Initial repository synchronization then uses the normal
Git deadlines, and its completion releases queued model work. Shutdown owns and
drains both stages, including cancellation before any Git command starts. Native CLI and process-tool
dispatches wait for setup within their existing invocation deadline. A shorter
invocation, command or probe deadline still wins. Read-only files, web requests
and HTTP MCP tools do not require native setup; stdio MCP, command, candidate and
other process-capable tools do. Diagnostic and pilot commands announce setup
before running their unchanged provider checks (15-second probe deadlines, with one retry of the login probe).

## Private interaction API and CLI

Authenticated `POST /api/interactions` provides:

| Action | Required fields | Purpose |
| --- | --- | --- |
| get | sessionId | Read current phase, revision, pending question and turn summaries |
| turn | sessionId, turnId | Inspect one private dispatch, result and continuation relationship |
| answer | sessionId, pendingId, expectedRevision, operationId, answer | Accept a response and queue continuation |
| resume | sessionId, turnId, expectedRevision, operationId; optional message | Continue the latest failed/cancelled/interrupted turn from saved context |
| cancel | sessionId, pendingId, expectedRevision, operationId | Cancel the current pending decision while retaining its historical question/result |
| events | sessionId; optional after, limit | Replay committed lifecycle events after a sequence cursor |

The portable commands are `interaction get`, `interaction turn`,
`interaction answer`, `interaction cancel`, `interaction events` and
`interaction resume`; `task resume` is an alias. See the
[portable CLI reference](portable-apps.md) for exact flags and the
[answer/resume guide](../how-to/answer-and-resume-worker.md) for examples.

The numeric interaction revision is distinct from a feature file's SHA-256
revision. Read the owning interaction immediately before an answer or resume.
Operation keys contain 1–100 letters, digits, underscores or hyphens. Reuse the
same key and unchanged input after a lost acknowledgement. A repeated accepted
operation does not launch another invocation. Reusing its key for different input
or answering a stale question conflicts. Read current state after acceptance;
an invocation may already have advanced by the time the response arrives.

Turn summaries are bounded to the latest 100 entries and report `totalTurns`.
Inspect a known turn ID directly for its retained checkpoint. For complete
numeric attempt traversal and all-matching consumption analysis, use
[run evidence](worker-run-metrics.md).

## Events for applications and agents

The worker exposes a versioned, durable event journal through the authenticated
interaction API. This is polling/replay, not model-token streaming or SSE. An
application uses worker events rather than interpreting provider-specific JSONL,
SDK callbacks or raw error strings. Disconnecting a reader does not stop a task.
The built-in webview currently polls the interaction view and private turn; the
event feed is available for application and agent integrations.

Each event contains `schemaVersion`, stable `id`, monotonic `sequence`,
`sessionId`, interaction `revision`, `turnId`, `runId`, `type`, `at` and
`phase`. `turnId` and `runId` can be null before that identity exists; event and
session IDs are always present. A `usage_observed` event requires normalized
numeric `usage`. A `tool_budget_exhausted` event requires `toolBudget`. Input
events require `pendingId` and `requestKind`; failed and interrupted events
require a safe `errorCode`. Event types are:

- `accepted`, `prepared`, `started`: durable command, dispatch and execution boundaries.
- `usage_observed`: the latest cumulative usage for this invocation, not an additive delta.
- `tool_budget_exhausted`: the invocation's shared tool budget ran out, at most once per turn. See [tool budget](#tool-budget).
- `input_requested`, `escalated`: a persisted blocking decision; fetch the current view for its content and answer guard.
- `completed`, `failed`, `cancelled`, `interrupted`: the invocation's terminal state.
- `pending_cancelled`: the pending decision was cancelled; the earlier invocation/result stays in history.

State transitions and their events commit in the same SQLite transaction. Replay
keeps event IDs and order. Events contain identity/state and available numeric
usage, without prompts, results, question text or raw provider errors. Inspect the
private turn when content is needed; numeric run exports remain a separate API.

Read with `action: events`, a session ID, nonnegative `after` sequence (default
zero) and `limit` from 1 to 100. The response contains `events`, `nextAfter`
and `hasMore`. Persist the returned cursor after processing; use `hasMore` to
drain the current backlog, then poll from that cursor. Sequences are monotonic
across the journal, so gaps in one session are expected. Consumers deduplicate by
stable event ID and must not trigger a second model call when replaying events.

Capabilities explicitly distinguish event replay from live provider streaming.
A future app-server or SDK adapter can normalize additional provider signals only
through a versioned capability/contract change; the UI never receives raw provider
approval payloads or gains tools from a progress event.

## Recovery and consumption

The worker records a validated model result before updating its transcript,
taskboard and request projections. For a proposal-only file task, the interaction
turn keeps the provider's change set unchanged; the transcript receives a readable
summary with changed paths and line counts instead of protocol JSON. Large edits
use labelled approximate counts. Candidate implementations retain their plain-text
completion summary and captured verification evidence. Protocol continuation
replays the unchanged interaction result, not its display text. After restart it
can reconcile a known saved
result without making another model call. If the provider may have received the
request but no result was durably saved, the worker marks the turn interrupted.
A deliberate resume starts another invocation and may consume additional tokens.
Worker admission deduplication is not an exactly-once guarantee from a provider.

`worker_context_replay` preserves saved inputs and successful context plus an
answer or optional continuation message. It does not restore hidden reasoning,
a cancelled subprocess, a remote tool stack or native provider session memory.
Reopening a session or restarting the worker does not automatically resume an
ambiguous invocation.

Usage checkpoints replace the latest cumulative observation for one invocation;
they are not repeatedly summed. Observed usage survives interruption where it was
saved. Recovery observations leave unavailable execution-end duration/CPU null.
Each answer or resume contributes a separate run to analysis. Missing consumption
is unknown, and cache tokens are subsets of normalized input.

`providerReportedCostUsd` is a reported amount with `costBasis`; it can be an
estimate, not an invoice charge. Claude reports client-side estimates. Older rows
without provenance remain unknown. Failed Claude crash results that merely zero
counters do not establish free execution. No subscription balance, account-wide
bill or model quality is inferred from these records.

## Storage and limits

Private semantic prompts/results live in `worker-interactions.sqlite` beside the
content-free `worker-runs.sqlite` journal. Private provider checkpoints live under
`model-sessions/` in the worker state directory, with prior revisions under
`model-sessions/history/` and scoped child receipts under
`model-sessions/delegation/`. Back up the complete stopped worker state, including
any SQLite WAL files and native CLI state needed for resumption. Treat dispatch
and receipt inspection as access to project content. Numeric run exports do not include these prompt/response bodies.

Active model context is bounded. Older content is replaced by an explicit archive
checkpoint while the original accepted scope and recent question/answer remain
available. The model can retrieve retained private turns with
`werk_session_history`, which cannot select another Feature Request. This is
context selection, not a model-generated summary. The webview also bounds its
transcript projection; the private turn journal remains authoritative. Legacy
unbound sessions retain their original bounds. Logical deletion does not securely
erase backups or storage media.

Claude and Cursor CLIs use explicit native session identifiers for continuation.
Codex keeps isolated exec invocations and worker context replay; direct APIs also await
a bounded invocation using worker-managed context. Native handles are private and
never grant tools. An uncertain provider turn is fenced until an explicit
recovery operation; a restart does not silently retry it.

Granted tools use the worker-owned catalog: API adapters exchange function calls
and results, while CLI adapters receive a private MCP bridge. Codex and Claude
provider-native tools remain disabled; Cursor native tools follow its separate
operator policy. Werk tool calls and output are bounded; a revoked worker policy
or ungranted Werk tool fails closed. Tool output is untrusted data and cannot authorize
additional tools.

### Shared project context

For repository-backed implementation requests, commit a
`.werk/model-context.json` manifest with the project documents each request
should receive:

```json
{
  "schemaVersion": 1,
  "paths": ["README.md", "docs/architecture.md", "docs/conventions.md"]
}
```

Use 1–32 unique safe relative paths to ordinary UTF-8 `.md`, `.txt` or `.json`
files. Hidden paths, secret/key names, symlinks and path aliases are refused.
Each file must fit within 32 KiB; selected content must fit within 128 KiB total.
The worker reads the manifest and content from the request's accepted source
commit, then records their hashes. Uncommitted edits do not alter an accepted
dispatch. Omitting the manifest adds no shared context. These documents provide
knowledge; they cannot expand repository scope, change tools or replace required
checks.

### Subagent ownership

For Codex, Claude and direct API adapters, an enabled delegation grant adds
`werk_delegate` to the parent catalog. Cursor does not receive this tool; its
native subagents follow Cursor policy and have unavailable usage rather than
Werk's bounded child receipts. Worker-managed child sessions share the Feature Request, accepted provider/model/profile, current
scope, deadline and tool-call budget. A child may receive fewer tools and cannot
delegate further. Its invocation has separate consumption and run evidence with
parent linkage; the numeric journal remains content-free. A child question is
returned to the parent rather than creating a competing Task workflow. See
[enable delegation](../how-to/manage-model-tools.md#allow-the-model-to-delegate)
for limits and the operator setup.

The bound history tool lists retained turns with `{}` or an `after` sequence
cursor. Read a turn with `{ "turnId": "ID", "offset": 0 }`. It returns at most
16,000 characters per chunk and a continuation offset. Use `{ "receipts": true }`
to list child receipts, `afterReceipt` to page the list, and
`{ "receiptId": "ID", "offset": 0 }` to inspect one. Lists contain at most 20
entries. Receipt content is bounded; a shortened child response tells the parent
to request narrower work. Neither history mode can select another request's
session or change its execution state.

The [dated integration review](../reports/worker-durable-sessions-review.md)
compares SDKs, app-server, ACP, MCP and subscription authentication paths.

### Tool budget

All tool calls of one invocation share its captured execution budget: 128 calls
and six hours by default, configurable up to 512 calls and 24 hours. The runtime
window is an additional bound starting with the first tool call; the overall
invocation deadline starts earlier and remains authoritative. It never grants
more time. The model receives budget information in tool results:

- **Low budget note.** Once a quarter or less of the calls or of the window
  remains (32 of 128 calls with the default call allowance), every tool result ends with an
  extra text item, for example
  `Tool budget: 32 of 128 calls and 120 s of the 21600 s tool window remain.`
  The result of the last allowed call says that no further calls will run.
  The note is a separate content item, so JSON tool output stays parseable and
  the 128 KiB limit still applies to the tool's own output. Earlier results are
  unchanged. Remaining time is rounded down to whole seconds.
- **Exhaustion.** A call beyond the limit, or after the window ended, runs
  nothing and returns a normal tool error (`isError: true`), for example
  `Tool budget exhausted (128 calls / 21600 s window): the 128-call limit of this invocation is reached. No further tool calls will run in this invocation. Finish with the information you have, or ask the operator with a werkInteraction question.`
  A call still running when the window ends is stopped and returns the same kind
  of error, stating that its result is unavailable.
- **Provider loops.** Claude Code and Codex receive the error as an MCP tool
  result. API adapters return it as a function or tool result and allow one more
  model response to finish. A model that requests tools again after it received
  the refusal is stopped with `protocol`.

Cancellation, revoked grants and a replaced worktree still fail closed with a
`tool_access` or `cancelled` error; only the tool budget is reported this way.
The overall invocation deadline can cancel the provider before a budget refusal
or final answer is delivered. It is never extended for a finishing response.

When a budget runs out, the turn records `toolBudget` and the event journal adds
one `tool_budget_exhausted` event:

```json
{ "reason": "calls", "maxCalls": 128, "windowMs": 21600000, "callsUsed": 128, "refusedCalls": 1 }
```

`reason` is `calls` or `window`. `callsUsed` counts calls admitted to execution;
`refusedCalls` counts calls that returned the budget error, including a call
stopped by the window. The record contains counts and durations only: no tool
names, arguments, results or paths. Using exactly the whole budget without a
further call is not exhaustion. Turns saved by earlier workers have no
`toolBudget`. The worker task view shows it with the latest turn's consumption.
Claude Code sessions require version 2.1.257 or newer. The saved connection check
reports known older versions with upgrade guidance; an unknown version remains
unverified. Native execution checks the version before inference and never drops
required isolation or system-prompt refresh flags. Usage normalization distinguishes
per-invocation cost in versions 2.1.257–2.1.276 from cumulative native-session cost
in 2.1.277 and newer. An unprovable cost delta remains unknown.

Native resume is available only through the advertised session profile. Live
streaming, provider compaction and background-response retrieval remain separate
capabilities; granting tools does not enable them.
