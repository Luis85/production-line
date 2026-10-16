# Worker–model interaction contract

The local worker owns prompt state and continuation. The adapter translates a
versioned request to a supported provider and returns a typed result. This contract
covers local Chat, approved-file tasks and their feature requests. Original remote
orchestrator executions retain their lease and execution authority.

## Capabilities and dispatch

Use `capabilities` in the portable worker CLI to inspect the active wrapper
contract. The current adapters expose structured questions through Werk protocol
version 1 and report usage when the provider supplies it. They declare
`continuation: worker_context_replay`, `nativeResume: false`, `streaming: false`
and default to `tools: none`. An invocation with an operator-granted catalog
records `tools: granted` and its public tool manifest. These describe the wrapper,
not everything the provider brand or its other SDKs can do.

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
rewrite an accepted instruction or model identity. Patch continuation preserves
the approved file snapshots and produces a patch for review, without applying it
to the project. Continuations use current tool grants; old dispatch evidence
cannot restore revoked access. Automated request reviewers remain tool-free.
See [manage model tools](../how-to/manage-model-tools.md) for scope, MCP connections
and revocation.

## Typed results

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

## Approved-file patch replies

A file task asks for one JSON object and states these limits in its prompt:

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
or `files`; two different such objects are refused as ambiguous. Every rule above
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
| `patch_reply_ambiguous` | More than one different patch object was found |
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
feature request through worker-managed metadata/companion content. Editing that
projection or the original Markdown body is not an authenticated answer. Use the
CLI/UI interaction operation so the question identity and revision are checked.

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
numeric `usage`. Input events require `pendingId` and `requestKind`; failed and
interrupted events require a safe `errorCode`. Event types are:

- `accepted`, `prepared`, `started`: durable command, dispatch and execution boundaries.
- `usage_observed`: the latest cumulative usage for this invocation, not an additive delta.
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
taskboard and request projections. After restart it can reconcile a known saved
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
content-free `worker-runs.sqlite` journal. Back up the complete stopped worker
state, including any SQLite WAL files. Treat dispatch inspection as access to
project content. Numeric run exports do not include these prompt/response bodies.

Saved context is bounded; exceeding its limit returns an actionable error rather
than silently dropping unresolved questions or accepted input. Session deletion
removes its private interaction records while numeric run history keeps its
existing retention contract. This is logical deletion, not secure erasure of
backups or storage media.

Current adapters default to no tools, use ephemeral CLI invocations and await
API completion. Granted tools use the worker-owned catalog: API adapters exchange
function calls and results, while CLI adapters receive a private MCP bridge.
Provider-native tools remain disabled. Tool calls and output are bounded; a
revoked policy or ungranted tool fails closed. Tool output is untrusted data and
cannot authorize additional tools.
Claude Code restriction flags require version 2.1.248 or newer. The saved
connection check reports a known older version with upgrade guidance; an unknown
version remains unverified. Execution never drops required flags. Provider
features such as native resume, live streaming, compaction, background response
retrieval require separately implemented capabilities; they are not implied by
this interface. Explicit tool grants do not enable these features.
