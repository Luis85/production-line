# Shared Git feature intake contract

Shared intake connects a worker-local repository binding to versioned Markdown
requests, a template, stage-specific gate rules and an Obsidian Base. See
[operating shared intake](../how-to/shared-feature-intake.md) and
[offline authoring](../how-to/team-feature-authoring.md) for procedures.

## Local binding and repository workflow

The authenticated worker saves this connection in private state:

```json
{
  "enabled": true,
  "repositoryId": "project",
  "remote": "origin",
  "branch": "main",
  "workflowPath": ".werk/feature-workflow.json",
  "pollMs": 5000
}
```

`repositoryId` must resolve to an assigned repository. `remote` names an existing
Git remote; it is not a URL or credential. `branch` identifies the shared intake
branch. `workflowPath` is repository-relative. `pollMs` is an integer from 1,000
to 300,000. New workers start disabled. Disabling prevents new claims while owned
work and its publication continue to reconcile. A retained repository binding
continues to suppress legacy folder admission and mutations, including while
disabled; legacy get/result/validate remain available. Explicitly saving disabled
configuration with an empty repository ID restores local intake after owned work
and publication have finished.

Connection changes require the current configuration revision, paused and drained
execution, and no active synchronization. The repository/remote/branch/workflow
binding cannot change while owned work or publication remains unresolved.

The default checked-in workflow is:

```json
{
  "schemaVersion": 1,
  "id": "feature-requests",
  "requestsDirectory": "features",
  "reviewDirectory": "feature-reviews",
  "tasksDirectory": "feature-tasks",
  "template": "features/_templates/feature-request.md",
  "base": "Feature Requests.base",
  "readyCheck": "fr-ready-check.json",
  "doneCheck": "fr-done-check.json"
}
```

`init --workflow-dir DIR` or `feature setup --workflow-dir DIR` generates a new workflow
with `reviewDirectory` `DIR/reviews`, `tasksDirectory` `DIR/tasks`, `base`
`DIR/Feature Requests.base`, and `readyCheck`/`doneCheck` `DIR/checks/fr-ready-check.json`
and `DIR/checks/fr-done-check.json`; the Base's folder filters use those paths. An
existing workflow file is never rewritten: a differing `--workflow-dir` yields a
`workflow_directory_mismatch` warning.

Paths use safe repository-relative POSIX syntax. Request and review folders must
be separate and cannot contain one another. Workflow files use distinct paths;
the template must not appear as a normal root-level intake request. Paths cannot
escape the repository or overlap private worker storage, installed applications
or agent integration locations. `tasksDirectory` is optional for backward
compatibility: omission resolves to `<reviewDirectory>/_tasks`. New workflows use
`feature-tasks`. Task storage must not overlap requests, contain the review root,
or overlap publication receipts under `<reviewDirectory>/_operations`; a separate
review subfolder is allowed. Files are read as bounded ordinary UTF-8 Git
blobs from an immutable full commit ID; symlinks and submodules are refused.

Workflow configuration is limited to 16 KiB. Each check, template and Base is
limited to 64 KiB. Missing or invalid required files block new intake instead of
falling back to private worker defaults. Already owned requests retain their valid
frozen workflow and can finish publication independently of changed defaults.

### Optional definition prompts

The workflow also accepts `readyPrompt` and `donePrompt`. Each names a team-owned
Markdown (`.md`) or plain-text (`.txt`) file relative to the repository root. Both
are optional; either can be configured independently. Omitting them preserves the
existing workflow without additional definition prompts. For example, merge these
fields into the complete workflow object above:

```json
{
  "readyPrompt": "docs/worker/definition-of-ready.md",
  "donePrompt": "docs/worker/definition-of-done.md"
}
```

Each configured file must contain nonempty, valid UTF-8 text within 64 KiB. Safe
workflow path rules apply; binary files, symlinks, submodules and paths outside the
repository are refused. Prompt files use distinct paths from each other and other
workflow files, and cannot be approved implementation-edit paths. Missing or
invalid configured prompts block new intake before a claim or model dispatch.

The worker reads both prompts from the same immutable source commit as the
request's workflow. It retains their paths, SHA-256 digests and exact content with
the accepted request, then supplies that content as model guidance when dispatching
it. Authorized answers, retries, continuations and restart recovery keep the
accepted definitions. Editing or deleting a prompt on the shared branch does not
replace an owned request's definitions; use a successor request for changed
requirements.

These prompts complement the deterministic `readyCheck` and `doneCheck` files.
They do not run an additional readiness evaluator, grant tools or edit scope,
establish verification evidence, or authorize approval and merge. The model must
still satisfy the existing request gates using the evidence those gates require.
Both Markdown intake and webview-authored shared requests use this contract.
Unbound local intake does not load `.werk/feature-workflow.json` or these prompts.

The shared-workflow view discloses configured paths and digests. Edit the files
and workflow in the project, review them, then commit and push them to the watched
branch. See [configure team definition prompts](../how-to/team-feature-authoring.md#add-definition-of-ready-and-done-prompts)
for examples and setup behavior.

### Optional Feature Request Ready Check

Set `readyReviewPrompt` to a separate repository-relative `.md` or `.txt` file to
ask the model to review a Feature Request before its deterministic readiness
checks. Omission disables this stage. The file follows the same size, text and
path rules as the definition prompts, and cannot share their paths. Merge this
field into the existing workflow object:

```json
{
  "readyReviewPrompt": "docs/worker/feature-request-ready-check.md"
}
```

| Optional field | Purpose | When the model uses it |
| --- | --- | --- |
| `readyReviewPrompt` | Review request clarity and identify missing team decisions | Before deterministic readiness checks and implementation |
| `readyPrompt` | Team definition of ready as implementation guidance | Implementation dispatch and its continuations |
| `donePrompt` | Team definition of done as implementation guidance | Implementation dispatch and its continuations |

The Ready Check uses the Feature Request's selected model and shares the worker's
execution capacity and consumption allowance. Codex, Claude and API reviewers
have no tools; Cursor uses native read-only ask mode under the operator's Cursor
permissions and hooks, without Werk's no-tools isolation guarantee. See the
[Cursor boundary](model-interaction.md#cursor-native-execution). The worker confirms
its shared Git claim before dispatching the review and freezes the review prompt
for that owned request. Changing the configured file affects future claims,
not an existing review or its follow-up rounds.

A configured Ready Check admits structurally valid requests for review before
semantic completeness and the JSON definition of ready pass. Identity, ownership,
format, bounded input and approved-scope protections still apply. A model pass
allows the worker to evaluate the existing deterministic readiness checks; it cannot bypass those checks, completion checks, verified evidence
requirements or human merge.

Findings and questions are published in the original Feature Request under the
generated `## Feature Request Ready Check` section. Its `### Answers` area is the
team's response channel. Public status is `reviewing_ready` during review,
`waiting_ready_input` when clarification is needed, or `blocked` when review cannot
proceed. Review does not create a separate Task note or implementation request.

While the Ready Check waits, the team may edit Answers and the original authored
request details, approved scope and compatible instruction-profile fields.
The accepted provider, model and effort stay fixed. Changing the provider value
or adding, removing or changing a model/effort override requires a successor
request. Adding or removing the provider field is allowed only when it still
resolves to the accepted provider. A changed profile's model default cannot
replace that frozen selection. The stable request ID, template
identity, worker-owned frontmatter and generated
findings/questions must stay intact. Set the top-level `status: ready`, commit and
push to request another review. Changed input must still satisfy the structural,
provider and safe-path checks. Answers are at most 8,000 characters, and the
combined authored request, rendered metadata and answers must fit the existing
8,000-character input budget. In addition, the authored Markdown submitted to a
Ready Check is limited to 32 KiB (32,768 UTF-8 bytes), including frontmatter,
YAML comments and team answers. On a response, generated progress and reviewer
output are excluded from this authored-input limit. These limits apply alongside
the existing 64 KiB complete Feature Request note limit; prompt files retain
their separate 64 KiB limit. Workflows without a Ready Check keep their existing
input limits.

The generated review report is bounded to 20 KiB to leave room for the authored
request and worker metadata. A visible notice identifies a shortened report;
complete findings remain in the worker's shared-request review details and are
supplied to the next reviewer. The answer area is never truncated.

Only a substantive request or answer change authorizes a new review generation.
An unchanged note, a status-only toggle, repeated polling or a lost publication
response does not repeat model execution. Failed or interrupted reviews hold for
explicit recovery: resolve the reported blocker, then add a substantive answer or
recovery clarification, or revise the original request details, and commit and
push `status: ready`. The worker does not automatically repeat model review.

After a passing review and deterministic readiness checks, the accepted input is
frozen for implementation. Later questions use the existing Task-note workflow;
changed implementation requirements need a successor request. See the
[Ready Check guide](../how-to/team-feature-authoring.md#review-requests-before-implementation)
for the author journey.

## Request and template contract

Shared mode accepts approved-file patch requests only. It retains the existing
[Markdown frontmatter parser](feature-requests.md), with these additional rules:

- `schemaVersion: 1`, a stable lowercase `id`, matching `templateId`, nonempty
  bounded title, explicit `status: ready` and `mode: patch` are required for intake.
  Offline validation also accepts `draft` without submitting it.
- Before implementation, `paths` supplies 1–32 unique approved relative files.
  A Ready Check may begin with no approved files; any supplied paths must follow
  the [approved file path rule](feature-requests.md#approved-file-paths), checked
  before a remote claim. Names may use Unicode letters, such as umlauts,
  and common punctuation. Paths are compared in NFC form. A path is bounded to
  240 characters, and each segment to 255 UTF-8 bytes. Dot-prefixed path
  components, traversal, Windows-reserved characters and device names,
  credential/secret filenames and private key extensions are rejected. New
  ordinary files are allowed, but a new file cannot differ from a tracked file
  only by letter case or Unicode normalization. Workflow configuration, checks,
  template, Base and prompt files, and request/review and Task namespaces cannot
  be changed by the feature patch.
- Before implementation, Goal, Context, Acceptance criteria and Verification
  plan headings are required, with substantive core text after HTML comments and
  fenced examples are excluded. Acceptance criteria contain 1–32 nonempty list
  items, each at most 1,000 characters. Duplicate headings are rejected. With a
  Ready Check configured, structurally valid input with missing sections or
  criteria may enter review; implementation still requires the completed content
  and passing ready rules.
- Additional headings and frontmatter fields in the configured template become
  required input before implementation. The template itself uses draft patch
  mode and a stable `templateId`. Setup preserves team changes.
- Custom request metadata is retained and rendered into an explicit context block
  for the model. Body plus rendered metadata must fit 8,000 characters. Metadata
  cannot grant tools, change execution policy or establish verification evidence.
- New requests contain no worker-owned `werk` or `source` metadata. After claim,
  `status`, `werk.shared`, `werkOwner`, `werkTask`, `werkPullRequest` and the
  generated progress section are worker-owned lifecycle projections. Original
  author content may be revised through the waiting Ready Check contract above;
  implementation retains the finally accepted content. The links identify the
  current Task and review handoff.

Only Markdown files directly inside `requestsDirectory` are scanned;
underscore-prefixed filenames and nested folders are excluded. Duplicate IDs in
a scanned queue are reported. Accepted identity is scoped to the repository
binding and retained privately; renaming or editing a claimed source is not a new
execution request. Use a new ID for successor work.

An omitted provider uses the worker's saved `defaultProvider`; an unconfigured
legacy worker starts with Codex CLI unless its startup feature-provider seed says
otherwise. Newly generated templates explicitly record the initialization provider;
setup preserves existing templates. Requests can select `codex-cli`, `claude-cli`,
`openai-api`, `anthropic-api` or `cursor-cli`, plus optional `model` and `effort`.
An explicit request model takes precedence over a compatible instruction-profile
model and then the provider's default. Omitted effort inherits that provider's
worker default; explicit `default` uses provider behavior. The accepted selection
is frozen at claim, including through Ready Check clarifications and restarts.
See [selection rules](model-interaction.md#provider-model-and-effort-selection).
Credentials and supported instruction profiles come from the local worker.
Select a profile in committed requests and templates with `definitionRef`, a
stable name the worker operator assigns to an imported definition, rather than a
worker-generated `definitionId`. The claiming worker resolves the reference when
the task is admitted, and the task retains that worker's resolved snapshot. A
worker that cannot resolve the selection (no definition with that reference or ID,
an unknown agent, or a profile that needs `useInstructionsOnly: true`) does not
claim the request. It stays ready and unclaimed, with the reason in the request
view, until that worker can run it or another worker claims it. See
[agent definitions](agent-definitions.md#stable-references-for-committed-requests).
Accepted execution preserves its provider configuration. Werk-granted model tools remain subject to current worker policy and per-call
revocation checks; repository rules never grant Werk permissions. Cursor's native
tools and hooks follow the separate operator-managed Cursor policy.

## Ready and done JSON

Each stage file has exactly `schemaVersion`, `id`, `version`, `stage` and `rules`.
The schema version is `1`, version is a positive integer, and stage must match the
configured file. Both `chat` and `patch` rule arrays are required; shared intake
executes only patch requests. Rule facts, types and operators reuse the
[request gate vocabulary](request-gates.md): `eq`, `neq`, `gte` and `lte`.

For example, `fr-ready-check.json` can require two acceptance criteria:

```json
{
  "schemaVersion": 1,
  "id": "fr-ready-check",
  "version": 1,
  "stage": "ready",
  "rules": {
    "chat": [],
    "patch": [
      { "id": "two-criteria", "fact": "input.criteriaCount", "op": "gte", "value": 2 }
    ]
  }
}
```

A valid `fr-done-check.json` can additionally require explicit operator acceptance
of the known input and output before publication:

```json
{
  "schemaVersion": 1,
  "id": "fr-done-check",
  "version": 1,
  "stage": "done",
  "rules": {
    "chat": [],
    "patch": [
      { "id": "operator-reviewed-result", "fact": "operator.accepted", "op": "eq", "value": true }
    ]
  }
}
```

This optional rule holds the result for the worker's existing guarded attestation
control. A blocked Task can describe the required action, but its Markdown cannot
supply the attestation. The control does not merge the eventual feature branch. The generated defaults
use empty custom arrays and do not require this extra prepublication acceptance.

Mandatory checks are always added. Readiness requires a title, a bounded message,
at least one criterion, approved files and valid paths, in addition to template
validation. Completion requires a durably completed result, nonempty output,
valid patch protocol, a patch with at least one changed file, no pending input and
no unresolved blocking findings. Custom rules cannot remove these checks.
IDs beginning `werk-required-` are reserved. The combined policy permits at most
32 rules per stage/kind: shared patch checks leave room for 26 custom ready rules
and 25 custom done rules. The assembled policy retains the existing 64 KiB bound.

Missing facts are `unknown` and fail closed, including `neq` comparisons. Offline
validation cannot establish approved-file byte sizes; a rule using
`input.approvedBytes` can therefore block offline readiness. Neither a Markdown
checkbox nor model prose supplies `tests.passed` or `build.passed`. The current
shared lane has no independent test/build fact producer, and model tool results
are not automatically promoted into these facts. Requiring them leaves the result
held until a supported trusted evidence source exists. Configured implementation
checks record their own worker verification evidence, including
`output.verificationPassed`; this is separate from those generic facts. Inspect
the required-check results and retained digests rather than assuming that the
presence of a patch establishes passing tests.

The worker freezes the normalized policy, template, optional definition prompts,
source commit, accepted input and SHA-256 hashes of workflow files before
admission. Subsequent defaults do not change that generation. The generic
automatic advisory-review and model-rework loop remains disabled for shared
requests. The optional Ready Check is a stage of the same Feature Request, with
the response contract above; it does not create a second intake workflow. Once
implementation is admitted, changed input or policy needs a successor request.

## Markdown communication contract

| Note | Location | Human edits |
| --- | --- | --- |
| Feature request | `requestsDirectory`, original accepted filename | Author draft/ready input; answer or revise details while the Ready Check waits; use a successor for changed implementation requirements |
| Actionable `type: Task` | Configured Task directory | Its single `## Answer` section and `status: ready` |
| Diagnostic `type: Task`, `status: blocked` | Configured Task directory | Informational; follow the stated authorized operator action |
| `type: PullRequest` | `reviewDirectory`, immutable publication filename | Review evidence; it is not an execution or merge command |

Shared ingestion reads only remote committed objects. A ready request, Ready
Check answer or ready Task response must be committed and pushed to the watched
branch. Pulling updates the author's local Obsidian view; saving locally is not a
remote response.

Actionable Task frontmatter uses `schemaVersion: 1`, `type: Task`, `title`, `status`
and the immutable fields `id`, `featureId`, `owner`, `sessionId`, `action`,
`pendingId`, `turnId`, `expectedRevision`. `action` is `answer` or `resume`;
`pendingId` is null for resume and binds the actual question for answer. The
worker compares the complete identity with its durable record, then checks the
current interaction revision and checkpoint. Do not create, copy or retarget a
Task as a way to dispatch a model.

Editable response statuses are `draft`/`open` while writing and `ready` for
submission. The worker acknowledges `processed` or reports `error`, optionally
with `responseDigest` and error metadata. A nonempty Answer is required for both
actions. Answers retain internal line breaks, trim surrounding whitespace and
are bounded to 8,000 characters. Choices are guidance and freeform answers are
allowed. The note is at
most 64 KiB, frontmatter at most 16 KiB. Exactly one unfenced top-level
`## Answer` section is required; a heading inside a fenced code example is text.
Preserve the rest of the generated note when responding.

Answering starts an authorized continuation of the existing request using saved
context. A resume Task exists only for a supported failed/interrupted latest turn;
completed, cancelled or active turns are not resumable through notes. Repeated
polling or a lost acknowledgement reconciles the durable response identity instead
of authorizing a new answer. `processed` is an accepted response, not proof that
execution has started or finished.

Diagnostic Tasks do not use this executable response contract. Preclaim readiness
diagnostics use `kind: intake-diagnostic`, bind the inspected request through
`sourcePath` and `sourceDigest`, and record `blocked` or `resolved` when a corrected
ready request or restored configuration clears the blocker. They have no `action`
field. A removed, renamed or draft request may leave historical diagnostics at
the previously inspected digest. Modified diagnostic content
is preserved and can require restoration before an update; it does not prevent
independent requests from being inspected. They state the blocker and concrete
next action; they cannot authorize tool grants, policy
changes, request acceptance or operator attestations. Those operations retain
the existing authenticated controls. Editing a diagnostic note to `ready` does
not turn it into an actionable checkpoint.

The Base uses `werkOwner`, `werkTask` and `werkPullRequest` on request rows.
Structured API metadata remains under `werk.shared.taskNote` and
`werk.shared.reviewNote`. Historical notes retain their original format; a new
PullRequest note does not retroactively convert an old `feature-review` record.

## Ownership, publication and recovery

The worker persists a reservation before publishing a claim to the shared branch.
Publication checks the observed request revision and uses ordinary fast-forward
Git pushes. Before first task admission, the worker verifies the exact claimed
bytes still exist on the current remote branch. A foreign claim, source edit or
missing local journal cannot authorize another execution.

The existing serial executor runs the accepted task in an owned worktree pinned
to its source commit. Shared Git operations use separate worktrees and do not
stage or reset the developer checkout. The assigned-repository watcher preserves
that checkout while a shared repository binding exists, even when intake is disabled
or all owned requests have finished. Its view exposes `checkoutPreserved`, and it
can remain `behind`. Clearing the binding after owned work and publication finish
allows normal clean-checkout fast-forwarding to resume if Watch remains enabled.
Required repository assignments for unfinished work or publication are tracked
separately; disabling an otherwise finished binding permits assignment removal,
but does not authorize the watcher to change any checkout still assigned to it.

Execution completion, completion-gate acceptance, publication and human merge are
separate states. Typical projections are `ready`, `queued`, `running`,
`waiting_input`, `needs_rework`, `checking`, `publishing` and `ready_for_review`;
failures can appear as `failed`, `cancelled`, `interrupted` or `blocked`. Read the
gate findings and `publication` field alongside the status. The optional Ready
Check adds `reviewing_ready` and `waiting_ready_input` before implementation;
`status: ready` submits a changed answer for another review.
Publication is `synced` only when the current lifecycle and its review artifact
have confirmed publication receipts. Preparing a review note keeps publication
pending until the shared Git push is confirmed; recovery cannot treat an older
lifecycle receipt as confirmation of the new handoff.

A passing completion evaluation must match the current request input revision,
input hash, policy digest, run/turn identifiers and immutable output digest. The
worker applies only the validated approved-file patch in an isolated publication
worktree and pushes `werk/features/<feature-id>-<operation-suffix>`. It then
publishes `<reviewDirectory>/<feature-id>-<publication-digest-prefix>.md` with
`type: PullRequest` and the source lifecycle update. The note is a Markdown review
handoff, not a Git-hosting pull-request object. Feature branches are not
automatically merged or approved.

Private state stores the accepted snapshot and pending publication intent.
Publication identities include the repository binding, source commit, feature ID and output digest.
Git lifecycle receipts live under `<reviewDirectory>/_operations/`; feature commits
also record operation identity. These support confirmation after an interrupted
push response. Repeating synchronization retries publication without repeating
known model execution. Uncertain or interrupted inference needs explicit operator
handling and is not automatically replayed. Concurrent changes and conflicting
branches remain visible instead of being force-pushed away.

Retain the complete worker state for recovery. Copying only Git files to a new
worker does not transfer execution ownership. The journal retains at most 100
owned requests and is bounded to 16 MiB; removing public notes does not erase
private deduplication history. Plan a separate worker/state for further work when
that capacity is reached.

## Authenticated worker API

All routes use the worker webview's authenticated local API. Do not put the token
in URLs or checked-in files. The portable CLI's `api` command can use the saved
local token and a JSON request file.

`GET /api/shared-intake` returns the current view without starting synchronization:
configuration `revision`, `workerId`, `config`, `canEdit`, `blockedReason`, `state`,
`error`, `lastSyncedAt`, observed `sourceCommit`, workflow paths, check and prompt
digests, and `requests`. State is `disabled`, `idle`, `syncing` or `error`. A request
includes identity, owner, `isLocal`, status, source commit, update time, ready/done
findings, feature branch, review-note path, Task-note path, local task ID and publication state
(`pending`, `synced` or `error`). Read timestamps because observations may be stale.

`POST /api/shared-intake` accepts one of these bodies:

```json
{
  "action": "configure",
  "expectedRevision": 0,
  "config": {
    "enabled": true,
    "repositoryId": "project",
    "remote": "origin",
    "branch": "main",
    "workflowPath": ".werk/feature-workflow.json",
    "pollMs": 5000
  }
}
```

Replace `expectedRevision` with the value just read. Successful configuration
increments the revision and returns the view. Stale revisions and busy
configuration changes are rejected; refresh and reconcile rather than overwriting
another edit.

```json
{ "action": "sync" }
```

Synchronization uses the saved connection and can claim work and publish updates.
It returns the resulting view. An HTTP 200 response is not proof that every Git
operation succeeded; inspect the view and each request's publication/error fields.

```json
{ "action": "note", "id": "fr-example" }
```

Note lookup returns `{ "path": "…", "markdown": "…" }` for a request in the
current binding. It accepts a request ID, never an arbitrary filesystem path.
Local retained notes can be available before publication is confirmed; remote
notes are read at the last observed commit. Refresh if a remote note has not yet
been observed.

Unknown fields/actions are rejected. `configure` accepts no request ID;
`sync` accepts no configuration/revision fields or ID. Unauthenticated access is
rejected. Invalid input, stale/busy state, unavailable services and missing notes
use the worker API's existing error handling. Configuration revisions guard local
connection updates; Git publication operations retain separate durable receipts.
