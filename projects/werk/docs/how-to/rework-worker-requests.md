# Rework a held worker request

Use this workflow when readiness blocks execution or a completed model result
fails the request's completion gate. Read the [gate reference](../reference/request-gates.md)
first. These commands use the installed project CLI and private local worker;
replace IDs, revisions and keys with values from your own request.

## Inspect the blocker

```sh
node runtime/bin/apps/worker/cli.mjs request list --state-dir .werk/worker
node runtime/bin/apps/worker/cli.mjs request get --id REQUEST_ID --state-dir .werk/worker
node runtime/bin/apps/worker/cli.mjs request events --id REQUEST_ID --after 0 --limit 100 --state-dir .werk/worker
node runtime/bin/apps/worker/cli.mjs request schema --state-dir .werk/worker
```

Inspect the current `revision`, `inputRevision`, latest `ready`/`done` evaluation,
open findings and review status. The request panel exposes the same information.
A failed readiness evaluation has not admitted primary work. A model result can
exist while Request Done remains held. A waiting model question belongs to the
[answer/resume workflow](answer-and-resume-worker.md); do not answer it by editing
a generated gate file.

The default policy may queue one advisory review for a failed gate. Wait for its
recorded result before requesting additional model work. Review has the same
no-tools authority as ordinary worker execution, and consumes provider quota.

## Propose text without invoking a model

Copy the request's full current `input` into `proposal.json`, changing its message
only. Keep its kind, approved snapshots, criteria and context unchanged:

```json
{"input":{"kind":"chat","title":"Clarify retry behavior","message":"Explain when retries stop and how an operator resumes."}}
```

The small example applies to a chat request without additional criteria/context;
a patch request must retain its actual copied input, including approved files.
Then submit and inspect the pending candidate:

```sh
node runtime/bin/apps/worker/cli.mjs request propose --id REQUEST_ID --if-match CURRENT_REVISION --key proposal-1 --file proposal.json --state-dir .werk/worker
node runtime/bin/apps/worker/cli.mjs request get --id REQUEST_ID --state-dir .werk/worker
```

A proposal does not mutate accepted input or start inference. Write
`accept.json` as `{"candidateId":"PENDING_CANDIDATE_ID"}` and accept using the
new current revision:

```sh
node runtime/bin/apps/worker/cli.mjs request accept --id REQUEST_ID --if-match NEW_REVISION --key accept-1 --file accept.json --state-dir .werk/worker
```

Acceptance creates a new input generation, preserves history and reevaluates
readiness. A ready locally owned generation can be admitted through its owner;
inspect the response's `dispatch` and request state before issuing another command.
It never applies a generated patch to project files.

## Request bounded model rework

For a currently held failed stage, write `rework.json` as `{"stage":"ready"}`
or `{"stage":"done"}` and use the current revision:

```sh
node runtime/bin/apps/worker/cli.mjs request rework --id REQUEST_ID --if-match CURRENT_REVISION --key rework-1 --file rework.json --state-dir .werk/worker
```

This explicitly queues a quota-consuming advisory invocation. It can produce a
pending text candidate; inspect and accept it separately as above. Assignment to
`llm` alone is not a rework command. The policy bounds explicit attempts to at most
three. Unavailable providers, invalid output and interrupted work are visible
failures, not a background retry loop. After uncertainty or restart, inspect the
saved intent before deciding on a new guarded operation.

## Resolve findings and evaluate

For an advisory finding, write
`resolve.json` as `{"findingId":"FINDING_ID","note":"Decision and supporting context."}`:

```sh
node runtime/bin/apps/worker/cli.mjs request resolve --id REQUEST_ID --if-match CURRENT_REVISION --key resolve-1 --file resolve.json --state-dir .werk/worker
```

An operator note cannot erase a deterministic rule failure. Correct the input or
provide supported trusted evidence, then write `evaluate.json` as
`{"stage":"ready"}` or `{"stage":"done"}`:

```sh
node runtime/bin/apps/worker/cli.mjs request evaluate --id REQUEST_ID --if-match CURRENT_REVISION --key evaluate-1 --file evaluate.json --state-dir .werk/worker
```

If the policy requires operator acceptance, inspect the exact current result and
write `attest.json` with its current `inputHash`, `execution.outputDigest` and a
nonempty `note`. Submit with `request attest` and the same revision/key/file flags.
The attestation applies to those exact digests. It is neither passing test evidence
nor permission for the model to write files.

## Recover a saved command without duplicate inference

Keep the original key and JSON unchanged when retrying a lost response. An exact
receipt replay acknowledges the saved command and does not dispatch again.
If `dispatch.state` is `not_admitted`, read the latest request. If its current
generation remains ready and no primary admission exists, issue a new guarded
operation with a new key:

```sh
node runtime/bin/apps/worker/cli.mjs request execute --id REQUEST_ID --if-match CURRENT_REVISION --key execute-after-inspection-2 --state-dir .werk/worker
```

Do not interpret `admitted` as completed. Inspect lifecycle events and execution
state. Command persistence and owner admission are separate checkpoints; this
workflow does not promise exactly-once provider billing.

## Rework a remote request upstream

A remote request's input remains owned by the orchestrator. Local candidate
acceptance cannot replace it. Create a successor using the owning task's current
attempt and failed gate evaluation. The native source CLI accepts a normal new
task input file:

```sh
node src/orchestrator/dist/orchestrator/cli.js task successor --id TASK_ID --attempt ATTEMPT --evaluation EVALUATION_ID --key successor-1 --file new-task.json
```

The portable orchestrator CLI instead takes a full successor envelope in
`successor.json`:

```json
{"expectedAttempt":1,"evaluationId":"EVALUATION_ID","operationId":"successor-1","input":{"project":"demo","summary":"Revised task","criteria":["Record evidence"],"wikilinks":[],"provider":"codex"}}
```

```sh
node bin/apps/orchestrator/cli.mjs task successor --id TASK_ID --file successor.json
```

Use that orchestrator's normal task schema, authenticated connection and current
attempt; the abbreviated input above is illustrative, not a replacement for its
schema. Never edit lease snapshots or reuse an old lease to replace accepted input.
Only gate receipts/digests cross the boundary; private prompts and findings remain
worker-owned.

A remote completion hold with an already known successful result does not require
a new task when the missing requirement is supported evidence such as explicit
operator acceptance. After the Done evaluation passes, the worker reconciles the
original held attempt with its orchestrator. It verifies retained patch evidence
before release, does not invoke the model again, and leaves original snapshots
unchanged. Inspect the remote task for acknowledgement; local Done alone does not
prove that a disconnected orchestrator has received the decision.

## Inspect consumption and feature files

```sh
node runtime/bin/apps/worker/cli.mjs run analyze --purpose gate_review --state-dir .werk/worker
node runtime/bin/apps/worker/cli.mjs run analyze --purpose rework --state-dir .werk/worker
```

Unknown usage is not zero and reported estimates are not necessarily billed cost.
Feature `_gates/<feature-id>/` files are generated views. Editing them cannot
resolve findings, accept candidates or satisfy gates; use guarded CLI/UI actions.

For an existing project installation, rerun `node runtime/bin/apps/worker/cli.mjs init --state-dir state/worker` from the project root before committing generated findings. Initialization adds `_gates/` alongside `_questions/` and `_results/` to the configured feature folder’s ignore file, preserving operator rules. These generated projections can contain private request findings and are not source files.
