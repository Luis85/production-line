# Use Werk from Claude Code or Codex

Project setup installs a small, manually invoked skill for each supported project
agent. These skills delegate task intake, questions and evidence inspection to
Werk’s installed CLI. They do not start another worker or execute another model
invocation automatically.

## Install and inspect

Run the [project worker setup](project-worker.md) from the project directory.
Setup creates missing integration files and reports existing-file conflicts.
It preserves existing agent instructions, settings, permissions and hooks.

The integration uses these project files:

| File | Purpose |
| --- | --- |
| `.claude/skills/werk-worker/SKILL.md` | Claude Code’s recognized project skill. |
| `.agents/skills/werk-worker/SKILL.md` | Codex’s recognized project skill. |
| `.codex/werk-worker.md` | Supporting guide explicitly read by the Codex skill. |

The `.codex` guide is not an independently discovered skill. Werk does not edit
`.codex/config.toml`, `CLAUDE.md`, `AGENTS.md` or account credentials.

## Invoke the project skill

In Claude Code, invoke `/werk-worker`. In Codex, invoke `$werk-worker`.
Tell the agent what you want, including which project files may change. Ask it to
inspect the CLI’s schema/capabilities and the current worker state before acting.
A useful first request is: “Use Werk to create a draft feature request for this
change, validate it and show me the accepted scope before submitting it.”

The skill can create and validate requests, inspect state, answer a durable
question with its current identifier/revision, and compare run evidence. It uses
explicit operation keys for retry-safe admission. A missing provider or stopped
worker should produce setup guidance rather than an invented task result.

## Refresh safely

Inspect integration status or preview a synchronization from the project root:

```sh
node bin/apps/worker/cli.mjs integrations status
node bin/apps/worker/cli.mjs integrations plan
node bin/apps/worker/cli.mjs integrations sync --dry-run
```

Review the returned files and `planId`, then synchronize that exact plan:

```sh
node bin/apps/worker/cli.mjs integrations sync --if-match PLAN_ID
```

Add `--project-dir /path/to/project` when invoking the installed CLI from elsewhere.
Inspection and dry-run never write. Synchronization does not require starting
the worker or calling a provider.
A plan reports each target as missing, current, update, conflict or blocked.
Missing files can be created. Previously managed files can be updated only when
their contents still match the recorded managed version. User changes are
preserved and reported as conflicts; review and reconcile them yourself.
A filesystem boundary or concurrent edit can block the operation. Inspect a
fresh plan rather than reusing an outdated plan identifier.

A crashed synchronization can leave `.werk/agent-integrations.lock`. Werk never
removes a lock automatically merely because it looks old. Verify that every
CLI/API integration writer has stopped before removing that stale lock yourself.
Keep `.werk/agent-integrations.pending.json` and the ownership manifest intact,
inspect a fresh plan, then retry guarded sync. Recovery reconciles only writes
proven by that checkpoint and file hashes; unknown edits remain conflicts.

**Settings → Project integration** presents the same installed paths and guarded plan/apply
workflow. Integrations are available only for its configured project root;
requests cannot choose an arbitrary target folder.

## Questions, resources and evidence

A waiting question releases the worker slot. Use the accepted session’s current
interaction state before answering; editing a feature’s generated question
companion does not submit an answer. See [answer and resume](answer-and-resume-worker.md).

Inspect the running worker from its installed CLI:

```sh
node bin/apps/worker/cli.mjs resource status
node bin/apps/worker/cli.mjs resource events --after 0 --limit 100
```

Use `nextAfter` as the next event cursor, follow `hasMore`, and handle `gap`
when older retained events are unavailable. These commands inspect observations;
they do not make provider calls.

Open the resource monitor in **Metrics** to inspect the latest sample and active
warnings. Samples arrive every 10 seconds. Its memory, heap and CPU scope is the
Worker Node process; provider subprocesses are excluded. State-filesystem disk
availability and effective memory/CPU capacity provide context. Warning events
record opening and recovery transitions, and do not cancel or retry work.
The default long-running warning is one hour; the separate default execution
budget is six hours. Inspect the effective execution policy before starting
long work. `WERK_WORKER_MAX_RUNTIME_MS`, when set for the worker process,
overrides saved runtime settings; change that environment and restart to alter
the override.

See [long-running monitoring](monitor-long-running-worker.md) for measurement
failures, alert history and deployment limits.

Resource observations and numerical run evidence describe what Werk measured;
unknown provider usage remains unknown. A long wait or timeout is not successful
completion. Inspect the current phase, process/resource observations and latest
run outcome before deciding to cancel or explicitly resume.

These integrations run in your external project agent. Werk’s restricted
provider subprocess intentionally excludes project customizations and tools;
installing this skill does not grant that subprocess filesystem write access.
