# Run a shared Markdown queue with a local worker

One teammate runs the worker from `bin/apps/worker` in the project. Everyone else
uses the repository's template and **Create Feature Request** skill in their own
editor or coding assistant. A teammate with worker access can also create requests
and answer questions in the webview chat interface. Both interfaces target the
same Feature Request and shared Git lifecycle. Requests, progress, human answers
and review handoffs are Obsidian-compatible Markdown; offline authors need no
worker connection or provider credentials.

The shared branch is the communication channel: **commit and push** ready requests
and Task answers, then **pull** the worker's updates. Saving a file or making a
local commit alone does not start shared work.

## Prepare the shared repository

[Initialize a project worker](project-worker.md) from a verified release. This
installs the app and the authoring kit. To install only the kit in another project:

```sh
node /path/to/werk/bin/apps/worker/cli.mjs feature setup --project-dir /path/to/project
```

Review, commit and push the workflow configuration, template, Base, ready/done
rules, authoring script and skills listed in the [authoring guide](team-feature-authoring.md).
Keep `.env`, provider credentials and private worker state out of Git. A fresh
workflow uses `features`, `feature-tasks` and `feature-reviews`; all three folders
are configurable. Older workflows without `tasksDirectory` use
`<reviewDirectory>/_tasks`.

Choose the branch receiving requests and lifecycle notes. The worker's host Git
credentials must be able to fetch it, push lifecycle commits and create feature
branches. If branch protection forbids lifecycle pushes, use a dedicated shared
intake branch with the intended permissions. The worker does not bypass branch
protection or merge feature branches.

## Connect the worker

The `shared setup` bridge supports `claude-cli` and `codex-cli`. Sign in to the
chosen CLI on the worker machine. API providers use the separate authenticated
`provider configure`, repository assignment and `shared configure` commands;
inspect `schema` for their JSON inputs. New templates created by `init --provider`
include that provider explicitly; existing templates are preserved. Inspect the
template before connecting, especially when using Claude instead of Codex.

From the project root:

```sh
node bin/apps/worker/cli.mjs start
node bin/apps/worker/cli.mjs repository status
node bin/apps/worker/cli.mjs shared status
```

Review the discovered repository path, branch and remote. Create a local
`setup.json`, replacing the discovery ID, shared configuration revision and
provider executable with the values for your machine:

```json
{
  "expectedRevision": 0,
  "discoveryId": "ID_FROM_REPOSITORY_STATUS",
  "provider": {
    "id": "claude-cli",
    "executable": "/absolute/path/to/claude"
  },
  "intake": {
    "remote": "origin",
    "branch": "main",
    "workflowPath": ".werk/feature-workflow.json",
    "pollMs": 5000
  },
  "resume": true
}
```

Use `repositoryId` instead of `discoveryId` for a repository already assigned to
the worker. Keep local setup files private; do not commit machine-specific paths
or credentials. On Windows use the installed `claude.exe` path and follow the
[Claude requirements](use-worker-webview.md#connect-claude-or-codex).

```sh
node bin/apps/worker/cli.mjs shared setup --file setup.json --dry-run
node bin/apps/worker/cli.mjs shared setup --file setup.json
node bin/apps/worker/cli.mjs shared status
```

Review the dry run before applying. Setup pauses new starts, checks/configures the
provider, accepts only the selected repository, binds shared intake and synchronizes
while paused. It resumes only when requested and setup succeeds. Finish or cancel
queued/running work first. On failure, inspect the returned step and current state;
after a confirmed pause, failures before resume leave starts paused. If a
pause/resume acknowledgement is lost, inspect queue settings before retrying.
Refresh stale revisions instead of overwriting another edit.
Setup does not rewrite the committed template or rules, and a provider check does
not invoke the model or prove available quota.

Review [tool access](manage-model-tools.md) and [implementation checks](implement-feature.md)
for serious coding work. Setup preserves existing grants unless its optional
`toolAccess` field supplies an explicitly reviewed replacement. Repository rules,
Task answers and successful login never grant tools. The optional Settings webview
exposes the same provider, repository, tool and shared-intake controls.

A request carrying `templateId` belongs to shared intake. The local folder watcher
leaves it unchanged, even before a binding exists. Do not remove this marker to
force execution. If an older worker already admitted it locally, cancel unfinished
local work and restore the request from a clean Git revision while preserving
newer team edits and its shared ID before connecting.

## Submit a request from any clone

Use the [authoring workflow](team-feature-authoring.md): create a draft, complete
Goal, Context, Acceptance criteria and Verification plan, list approved files,
validate it, then explicitly mark it ready. Commit and push to the watched branch
using your normal Git review process. Requests must be root-level Markdown in the
configured folder with a stable ID, matching template ID and `mode: patch`.
Drafts, uncommitted changes, nested notes and underscore-prefixed files do not
start shared work.

The worker validates the request, template and rules from one remote Git commit.
It reserves a valid request durably and confirms its claim on the remote before
admitting model work. Invalid input remains unclaimed with readiness findings and a diagnostic Task;
correct it, validate, commit and push again. Preclaim diagnostics identify the
inspected source digest and change from `blocked` to `resolved` when that blocker
is cleared. Keep generated diagnostics unchanged: an edited note is preserved
and may need restoration before the worker can publish its acknowledgement.
Other independent requests can continue. A competing worker cannot silently
replace a confirmed owner.

## Submit through the worker webview

Open **Taskboard → New request** and describe the outcome in **Request instructions**.
Choose **Prepare request** to create a draft from the committed project template.
This is guided authoring, not a model invocation. Complete the request details,
approved paths and project-specific sections; **Check readiness** reports the
same configured rules used by offline authoring and shared intake.

**Save draft to Git** commits and pushes an unfinished request. **Mark ready and
publish** requires passing readiness checks and publishes a ready request. The
worker then observes, validates and claims that note through the existing shared
intake. The chat interface does not dispatch a separate implementation directly.
The displayed repository and branch are the publication destination; the
operator's developer checkout and index stay unchanged.

Open saved drafts under **Shared requests**. Once owned, use **Open conversation**
to inspect execution and answer pending questions. An unconfirmed publication
retains its exact command for **Retry same request**. Conflicting edits or changed
workflow files require rereading rather than overwriting another teammate's work.
See the [webview guide](use-worker-webview.md#create-and-follow-up-on-a-task).

## Read progress and answer a Task

Pull the shared branch. The original request shows `werkOwner`, lifecycle status,
a generated progress section and links in `werkTask` and `werkPullRequest`.
Obsidian's Base groups **Team feature requests**, **Human tasks** and **Pull requests**.
These are files in your clone, so their timestamps reflect your last Git update.

When the model needs a decision, follow the Task link. An actionable note has
`type: Task`, `action: answer` or `action: resume`, and an editable **Answer**
section. Preserve its IDs, owner, checkpoint, action and expected revision.

1. Read the question, choices or failure reason. Obtain the human decision when
   needed; a coding assistant must not invent approval.
2. Replace the placeholder under `## Answer` with the actual answer or continuation.
   For example: “Use the existing search endpoint; keep the current pagination.”
3. Change only `status` to `ready`, then commit and push the Task file to the shared
   branch. Do not change the accepted feature request body.
4. Pull the acknowledgement. `processed` means the worker accepted that response;
   continuation can still wait for capacity or a paused queue. `error` needs
   inspection and reconciliation, not copying the response into a new identity.

You can also submit the answer or supported continuation from the request
conversation in the webview. The worker publishes the same Task note response
and lets the existing Markdown consumer process it; this does not introduce a
second continuation path. A teammate can pull that answer and acknowledgement.

The worker checks the exact owned session, checkpoint and revision before issuing
the guarded interaction command. A valid response continues the existing request
with a new measured invocation; repeated synchronization does not intentionally
run the same response twice. Resume Tasks are offered only for supported failed
or interrupted latest turns, not for cancelled or completed work.

A **blocked** Task is a diagnostic with concrete next steps. It can describe a
provider problem, held completion rule or required operator action. It has no
executable Answer. Editing it cannot grant tools, attest acceptance, change policy
or bypass readiness/done checks. Follow its instructions using authorized worker
controls, or create a successor request for changed requirements.

## Review the PullRequest note and feature branch

Accepted input, approved paths, provider context, source commit and workflow rules
are retained. Execution uses the serial queue and an isolated worktree at that
commit. Later template/rule changes apply to new requests. Waiting for a human
releases the execution slot.

After a valid patch and matching passing completion evaluation are durable, the
worker pushes a branch under `werk/features/`. It publishes a **PullRequest**
Markdown note in the configured review folder and updates the source request to
`ready_for_review`. The note records acceptance criteria, recorded verification,
source/feature commits and policy digests. A retained local result may be complete
while Git publication is still pending; inspect both states.

Fetch the feature branch, inspect its changes and verification evidence, then use
your team's normal review and merge process. The Markdown note is not itself a
GitHub/GitLab pull request or merge approval. Default done rules establish a
reviewable patch; configure and inspect required project checks when tests/builds
must pass. A Markdown checkbox or model statement is not trusted test evidence.
The generic `tests.passed` and `build.passed` facts still have no trusted producer;
see the [exact gate contract](../reference/shared-feature-intake.md#ready-and-done-json).

## Recover without duplicating work

- **Readiness failed before a claim:** correct and republish the draft/request or
  future policy. No implementation invocation has been admitted.
- **Admission or execution needs attention:** read the linked Task and retained
  evidence. Restore provider/configuration/capacity as directed, or answer an
  actionable Task. Restart and ordinary polling do not replay uncertain inference.
- **Done checks held the result:** inspect missing/failed facts. Use authorized
  controls where applicable; a Task answer cannot weaken the frozen rule. Create
  a successor draft with a new ID for changed work or policy.
- **Git publication failed:** retain state, fix connectivity/authentication/branch
  permissions and synchronize again. Durable receipts support confirmation after
  a lost push response without another model call. Source conflicts and competing
  branches require inspection; the worker does not force-push them away.

Shared Git reads committed objects and writes isolated worktrees. It never stages,
resets or overwrites the developer checkout's tracked files/index. While a shared
binding exists, the repository watcher preserves that checkout, even when intake
is disabled or owned requests finish. It can report the checkout as behind; pull
intentionally to see shared notes.

## Pause intake and preserve recovery

Disable **Accept new shared requests** to stop new claims. Owned requests and
publication continue to reconcile. Connection changes require paused, drained
execution and no active synchronization. Stopping the worker stops synchronization;
its private journal and Git receipts remain.

Back up the complete worker state together with the repository using the
[backup guide](upgrade-backup.md). A clone alone cannot reconstruct execution
ownership. A remote claim without its local journal stays blocked: restore the
owning state instead of deleting metadata or changing the request back to ready.

A saved shared repository binding also suspends legacy folder admission and
mutations and refuses direct chat/file-task creation, including while new shared
claims are disabled. Local history remains readable. This prevents two intake
processes from executing the same project request; the webview still publishes
drafts and ready notes through the shared workflow. To return deliberately to local
intake, finish owned work/publication, then save a disabled connection with an
empty repository ID. This re-enables local ready files and normal clean-checkout
fast-forwarding when repository watching remains enabled.
