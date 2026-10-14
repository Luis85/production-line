# Answer a worker question and resume a stopped request

Start with an installed project worker and a configured provider. The
[feature lifecycle tutorial](../tutorials/worker-feature-lifecycle.md) covers
installation and request submission. This guide uses the portable worker CLI;
Chat exposes the same guarded interaction actions.

## Inspect a question

A structured clarification changes the request to `waiting_input`; an escalation
changes it to `escalated`. The provider invocation has ended and its consumption
is recorded. Other queued work can use the execution slot while you decide.

```sh
node bin/apps/worker/cli.mjs capabilities
node bin/apps/worker/cli.mjs feature get --name checkout.md
node bin/apps/worker/cli.mjs interaction get --id SESSION_ID
```

Use the request record's `sessionId`, not its feature ID or run ID. Read `pending.id`,
`pending.message`, its reason/choices, and the numeric interaction `revision`.
A task/feature wait returns the waiting state so automation can handle it; waiting
is not successful feature completion. Provider credentials belong in provider
settings, not in an answer to a model question.

## Answer once, with a recoverable acknowledgement

For example, if the current revision is 7:

```sh
node bin/apps/worker/cli.mjs interaction answer --id SESSION_ID --question-id PENDING_ID --if-match 7 --key checkout-answer-001 --message "Require a manual retry after showing the error."
node bin/apps/worker/cli.mjs interaction get --id SESSION_ID
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
applying it. Editing the accepted feature Markdown does not answer its question.

## Resume after failure, cancellation or restart

Read the latest interaction and inspect its checkpoint:

```sh
node bin/apps/worker/cli.mjs interaction get --id SESSION_ID
node bin/apps/worker/cli.mjs interaction turn --id SESSION_ID --turn-id TURN_ID
```

Check the saved provider/model, prompt, previous-turn link, outcome and error code.
The dispatch can contain project content; save/export it only where appropriate.
Fix the underlying provider/authentication issue first when needed.

Resume the latest stopped turn with its current numeric revision:

```sh
node bin/apps/worker/cli.mjs interaction resume --id SESSION_ID --turn-id TURN_ID --if-match 11 --key checkout-resume-001
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
node bin/apps/worker/cli.mjs interaction cancel --id SESSION_ID --question-id PENDING_ID --if-match 7 --key checkout-cancel-001
node bin/apps/worker/cli.mjs interaction events --id SESSION_ID --after 0 --limit 100
```

Cancellation preserves the historical question and consumption. A later explicit
resume creates another invocation. Normal worker shutdown preserves a pending
question for answering after restart.

For automation, process event pages in sequence, save `nextAfter`, and drain
`hasMore` before polling again. Retry reads freely; deduplicate by event ID.
Events summarize durable state without private prompt/result bodies.

## Compare the attempts

```sh
node bin/apps/worker/cli.mjs run list --session-id SESSION_ID
node bin/apps/worker/cli.mjs run analyze --session-id SESSION_ID
```

The questioning call, answer continuation and later resume remain separate
attempts. Unknown counters/cost remain null; reported USD can be an estimate.
History exposes execution evidence and request links; Chat shows the pending
action and saved continuation context. The
[interaction contract](../reference/model-interaction.md) explains authority,
private storage, recovery and idempotency in detail.
