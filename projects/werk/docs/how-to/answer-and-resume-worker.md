# Answer a worker question and resume a stopped request

Start with an installed project worker and a configured provider. The
[feature lifecycle tutorial](../tutorials/worker-feature-lifecycle.md) covers
installation and request submission. This guide uses the portable worker CLI;
Chat exposes the same guarded interaction actions.

## Answer through the canonical request

For a local `worker.request/v1` request, open the original Feature Request and
read its worker-managed questions and current blocker. Write the decision under
the user-owned `## Answers` section, using the question's ID. Preserve the ID and
worker-region markers. A material answer is a new semantic revision of the same
request; the worker reassesses readiness before dispatching more work. Review
questions and resulting history in the webview's request detail as well.

Do not put credentials in an answer, and do not edit generated status to indicate
that a check passed. If the source reports an edit conflict, missing file or
changed requirement while execution is active, resolve that hold before asking
for another action.

For canonical delivery, **Resume work** continues a compatible paused or
interrupted run. **Retry failed work** requires a known preceding outcome and
remaining limits. A cancelled or accepted request requires **Reopen request**;
ordinary editing or leaving `intent: submit` in place cannot reopen it. The
[Markdown command contract](../reference/feature-requests.md#candidate-decisions-and-execution-controls)
provides the equivalent run-targeted commands and replay rules.

Shared Git requests continue to use their linked Task response: answer it, mark
it ready, then commit and push it to the watched branch. Legacy local Task notes
use stable local saves. The CLI interaction examples below describe those saved
session checkpoints; they do not bypass a canonical request's terminal lifecycle
or unresolved source/gate holds.

## Inspect a question

A structured clarification changes the request to `waiting_input`; an escalation
changes it to `escalated`. The provider invocation has ended and its consumption
is recorded. Other queued work can use the execution slot while you decide.

```sh
node runtime/bin/apps/worker/cli.mjs capabilities --state-dir state/worker
node runtime/bin/apps/worker/cli.mjs feature get --name checkout.md --state-dir state/worker
node runtime/bin/apps/worker/cli.mjs interaction get --id SESSION_ID --state-dir state/worker
```

Use the request record's `sessionId`, not its feature ID or run ID. Read `pending.id`,
`pending.message`, its reason/choices, and the numeric interaction `revision`.
A task/feature wait returns the waiting state so automation can handle it; waiting
is not successful feature completion. Provider credentials belong in provider
settings, not in an answer to a model question.

## Answer once, with a recoverable acknowledgement

For example, if the current revision is 7:

```sh
node runtime/bin/apps/worker/cli.mjs interaction answer --id SESSION_ID --question-id PENDING_ID --if-match 7 --key checkout-answer-001 --message "Require a manual retry after showing the error." --state-dir state/worker
node runtime/bin/apps/worker/cli.mjs interaction get --id SESSION_ID --state-dir state/worker
```

The key identifies this one intended response. If the connection fails before you
receive an acknowledgement, retry the exact command with the same key and input.
Do not generate a fresh key merely because the response was lost. Conflicting
reuse or an obsolete question/revision is rejected. Read state and reconcile your
answer if another operator already changed it.

For multiline or agent-generated text, save a private `answer.json` containing
`{"answer":"Require a manual retry after showing the error."}` and use `--file
answer.json` instead of `--message`. Session/question identity, revision and key
remain explicit flags; the JSON file cannot replace them.

An accepted answer is persisted before continuation. It starts a new run in the
same session, using the saved request and answer. Patch requests retain their
original approved-file snapshots; inspect and review the resulting patch before
applying it. For legacy requests, use the linked Task or this interaction command; editing arbitrary prose in the accepted body does not answer that saved checkpoint.

## Resume a legacy checkpoint after failure or restart

Read the latest interaction and inspect its checkpoint:

```sh
node runtime/bin/apps/worker/cli.mjs interaction get --id SESSION_ID --state-dir state/worker
node runtime/bin/apps/worker/cli.mjs interaction turn --id SESSION_ID --turn-id TURN_ID --state-dir state/worker
```

Check the saved provider/model, prompt, previous-turn link, outcome and error code.
The dispatch can contain project content; save/export it only where appropriate.
Fix the underlying provider/authentication issue first when needed.

Resume the latest stopped turn with its current numeric revision:

```sh
node runtime/bin/apps/worker/cli.mjs interaction resume --id SESSION_ID --turn-id TURN_ID --if-match 11 --key checkout-resume-001 --state-dir state/worker
```

Optionally add `--message "Use the requirements already supplied; keep the manual
retry decision."`, or a private JSON file containing a `message` field. As with
answers, retries of a lost acknowledgement reuse the same key and identical input.
Answer a pending question through `interaction answer` instead of bypassing it with
resume.

The current wrapper resumes by `worker_context_replay`. It sends saved context in
a fresh provider invocation, not a restored hidden model session. A response lost
before durable storage cannot be reconstructed with certainty, and continuing can
incur additional consumption. Restart and reopening Chat do not silently replay it.
If a validated response was already saved, the worker reconciles that result
rather than asking the model to produce it again.

## Cancel a pending decision or follow events

To decline the current question, use its current identity and revision:

```sh
node runtime/bin/apps/worker/cli.mjs interaction cancel --id SESSION_ID --question-id PENDING_ID --if-match 7 --key checkout-cancel-001 --state-dir state/worker
node runtime/bin/apps/worker/cli.mjs interaction events --id SESSION_ID --after 0 --limit 100 --state-dir state/worker
```

Cancellation preserves the historical question and consumption. A later permitted
legacy checkpoint resume creates another invocation; canonical terminal requests
first require explicit reopening. Normal worker shutdown preserves a pending
question for answering after restart.

For automation, process event pages in sequence, save `nextAfter`, and drain
`hasMore` before polling again. Retry reads freely; deduplicate by event ID.
Events summarize durable state without private prompt/result bodies.

## Compare the attempts

```sh
node runtime/bin/apps/worker/cli.mjs run list --session-id SESSION_ID --state-dir state/worker
node runtime/bin/apps/worker/cli.mjs run analyze --session-id SESSION_ID --state-dir state/worker
```

The questioning call, answer continuation and later resume remain separate
attempts. Unknown counters/cost remain null; reported USD can be an estimate.
History exposes execution evidence and request links; Chat shows the pending
action and saved continuation context. The
[interaction contract](../reference/model-interaction.md) explains authority,
private storage, recovery and idempotency in detail.
