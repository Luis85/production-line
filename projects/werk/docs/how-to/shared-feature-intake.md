# Run shared Git feature requests with a local worker

Connect one worker to a shared Git branch so teammates can submit feature requests
from their own clones. The worker claims a ready request, runs its approved-file
task, checks the recorded result, and publishes a feature branch and an
Obsidian-compatible review note. Your team reviews and merges the implementation.

Authors can work entirely offline with the committed template and
[Create Feature Request kit](team-feature-authoring.md). They do not need access
to the worker or its provider credentials.

## Prepare the shared repository

Install the authoring kit once from a verified Werk release:

```sh
node /path/to/werk/bin/apps/worker/cli.mjs feature setup --project-dir /path/to/project
```

Review, commit and push the generated workflow configuration, template, Base,
ready/done check files, authoring script and skills. The authoring guide lists the
files. Keep private worker state and provider credentials out of Git.

Choose the branch that receives ready requests and lifecycle notes. The worker's
host Git credentials must be able to fetch it, push lifecycle commits to it, and
create feature branches. If branch protection prevents those lifecycle pushes,
use a dedicated shared intake branch with the intended permissions. The worker
does not bypass branch protection or merge feature branches.

## Connect the worker

Install and start a [project worker](project-worker.md). In its Dashboard:

1. Assign the local Git repository. Accept the detected installation repository
   if appropriate, or add the repository explicitly.
2. Configure and check the provider connection used by your requests. A request
   without `provider` uses `codex-cli`; other supported connections can be selected
   in its frontmatter. Model settings, credentials and instruction profiles belong
   to the local worker.
3. Review [model tool access](manage-model-tools.md). Shared requests inherit the
   worker's granted tools; a checked-in request or check file cannot grant access.
4. Pause new starts and finish or cancel queued and running work. In **Connect
   shared requests**, choose the assigned repository, remote name, shared branch,
   workflow file and polling interval. Save, then resume new starts.

Automation uses the same guarded path: `queue pause`, then `shared status` for the
current `revision`, `shared configure --file intake.json` with
`{"expectedRevision":N,"config":{"enabled":true,"repositoryId":"…","remote":"origin","branch":"…","workflowPath":".werk/feature-workflow.json","pollMs":60000}}`,
then `queue resume`. On Windows, configuration checks that Git worktree paths under
the worker state directory stay within Git's limits; a deep `--state-dir` is
rejected before any request is claimed.

Bind shared intake before teammates' ready requests reach the worker's checkout.
The local feature folder never admits a request carrying a `templateId`, including
an empty or invalid marker. It leaves the file unchanged and reports ready
requests until shared intake processes them, so a vault or sync tool cannot push
local lifecycle metadata back into a shared request. Incomplete shared drafts
remain outside local validation and execution.

If an older worker already admitted a shared request locally, its task history
remains available but local admission, retry and source-note updates are blocked.
Cancel any unfinished local task before connecting shared intake. Restore the
request from a clean Git revision, preserving any newer team edits and the shared
request ID, then inspect shared intake before resuming. Do not remove the
`templateId` to force local execution; the shared workflow owns its readiness
checks and claim.

The default workflow file is `.werk/feature-workflow.json`. Its paths configure
request and review-note folders, the template, the Obsidian Base and both check
files. The local connection selects which repository and branch supply those
files. Polling accepts 1–300 seconds, with a five-second default.

The shared-intake Git adapter reads committed objects and writes isolated
worktrees. It does not stage, reset or overwrite your developer checkout's tracked
files or index. The assigned-repository watcher preserves that checkout while the
shared repository binding exists, including when intake is disabled or all requests
are finished. It can report the checkout as behind instead of pulling. Clearing the
binding after owned work and publication finish allows ordinary repository watching
to resume fast-forwarding a clean checkout. Turn off **Watch** if you want the
checkout to remain fixed after clearing the binding.

## Submit a request from any clone

Follow the [authoring workflow](team-feature-authoring.md): create a draft, fill
in the template, validate it and explicitly mark it ready. Commit and push it to
the watched branch, using your normal Git review process when needed.

Only committed root-level Markdown requests in the configured request folder are
considered. Unsaved edits, uncommitted files, drafts and underscore-prefixed files
do not create shared work. A request needs a stable ID, the matching template ID,
`mode: patch`, explicit approved file paths, and completed Goal, Context,
Acceptance criteria and Verification plan sections. Additional template fields
and sections also apply.

Readiness uses the exact request, template and check files at one Git commit.
Invalid requests remain unclaimed; inspect **Needs attention**, correct the
source, and commit and push the correction. A valid request is reserved durably
and its claim must be confirmed on the remote branch before task admission. A
competing worker or concurrent source edit cannot silently replace that claim.

## Follow execution and review the result

Use **Sync shared requests** or wait for polling. Inspect a request to see its
owner, readiness and completion findings, source commit, publication state,
feature branch and review note. Pull the shared branch in an authoring clone to
update the Obsidian Base and Markdown lifecycle fields.

The worker preserves accepted input, approved paths, source commit and the
workflow snapshot. Later changes to the template or check files affect new
requests. They do not change an accepted request's rules. Execution uses the
existing serial worker queue and a task worktree at the accepted source commit.
Questions and operator decisions use the worker's existing guarded interaction
controls and release the execution slot while waiting.

After a valid patch and a matching passing completion evaluation are durable, the
worker pushes a branch under `werk/features/`. It then publishes a review note in
the configured review folder and updates the source request to
`ready_for_review`. The note records acceptance criteria, check results, source
and feature commits, and policy digests. A local result can be ready while its Git
publication is still pending; inspect both fields.

Fetch the feature branch, inspect the changes and verification evidence, and use
your team's normal pull-request and merge process. The worker does not create a
merge approval or merge the branch. Default done checks establish a reviewable
patch; they do not establish passing project tests. A Markdown checkbox or model
statement is not trusted test evidence.

## Handle failures and rework

- **Readiness failed before a claim:** correct the request or future policy in Git,
  validate, commit and push. No implementation model call has been admitted.
- **Provider or queue admission failed after a claim:** inspect the owning worker,
  restore its provider/configuration or available capacity, and synchronize again.
  The same durable task identity is retained.
- **Waiting for input:** answer or resume through the worker's current interaction
  controls. Editing a generated note does not answer the question.
- **Execution failed, was cancelled or was interrupted:** inspect retained task
  evidence. Another model execution requires an explicit guarded task action; a
  restart or repeated Git synchronization does not silently replay inference.
- **Done checks held the result:** inspect the failed or unknown facts. Changing
  the shared check file does not weaken this request's frozen policy. Use supported
  operator controls where applicable, or create a successor draft for changed
  work or policy and give it a new ID.
- **Git publication failed:** retain worker state and the result. Fix connectivity,
  Git authentication or branch permissions, then synchronize again. Publication
  receipts allow confirmation after a lost response without another model run.
  Source-content conflicts and conflicting feature branches require inspection;
  the worker does not force-push or overwrite the competing changes.

Rules requiring `tests.passed` or `build.passed` remain blocked when independent
trusted evidence is unavailable. The current shared workflow does not promote
model tool output into those facts. Do not expect a model's claimed success to
satisfy such a rule. See the [exact check contract](../reference/shared-feature-intake.md).

For changed accepted requirements, create a new draft with a new ID and link the
original in its Context section. Keep the old request and published evidence.
The shared workflow has no automatic model-rework loop or automatic merge.

## Pause intake and preserve recovery

Turn off **Accept new shared requests** to stop new claims. Already owned requests
and pending publication continue to reconcile. Saving connection changes still
requires paused, drained execution and no active synchronization. Stopping the
worker also stops synchronization; its private journal and Git receipts remain.

Back up the complete worker state together with the repository according to the
[backup guide](upgrade-backup.md). A Git clone alone cannot reconstruct the
private execution journal. If a remote claim has no matching local journal, the
worker reports it as blocked and does not execute it again. Restore the owning
state instead of deleting claim metadata or copying the request back to `ready`.

A saved shared repository binding also suspends legacy folder admission, including
while new shared claims are disabled. Legacy get, result and validate remain
available for history; its mutation commands are blocked. To return deliberately
to local folder intake, finish owned work and publication, then save a disabled
connection with an empty repository ID. Clearing the binding re-enables local
intake, so use it only when you intend local ready files to enter that queue.
