# From a release archive to a reviewed main checkout

This is the primary standalone worker journey: extract a runtime archive into a dedicated worker home, start the worker, create a Feature Request in its webview, observe implementation and Git updates, review the delivered increment, and explicitly allow its merge into the displayed main checkout. Git and a PullRequest Markdown handoff are sufficient; GitHub PRs and Releases are an optional, separately approved extension.

Use a verified Werk 0.17.0 or later archive for this tutorial. The 0.16.0 archive retains its older directory layout; follow the adoption guide before reusing its stopped state. The [qualification ledger](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reports/worker-release-workflow-acceptance.md) names the evidence actually obtained for candidate packaging, Git fixtures, browser interaction and native/live execution.

## Before you start

Use Node.js 24.x, Git and a supported provider. The selected native pilot is Windows with Claude Code CLI; install and sign in to Claude through its official CLI under the OS account that will run Werk. Provider authentication is separate from the worker's project/tool permissions. For the first run, choose a disposable project with an initial committed baseline and a Git remote you can read and push.

The worker owns a dedicated home and its project clones. Your main checkout means the assigned local repository path and target branch shown for the selected project; it does not mean an unrelated editor checkout on another path or machine.

## 1. Verify and extract the archive into a worker home

Obtain the matching versioned runtime archive and `SHA256SUMS` from your selected trusted delivery source. Verify the archive's SHA-256 before extraction. See [release artifact verification](../reference/releases.md#verify-before-extraction).

On Windows, inspect the downloaded archive hash before extraction:

```powershell
Get-FileHash -LiteralPath C:\Downloads\werk-VERSION.zip -Algorithm SHA256
```

Compare it with the exact ZIP entry in the matching `SHA256SUMS`. A mismatch stops
this procedure. Do not use GitHub's source-code ZIP in place of the runtime.

Choose a fresh directory such as `C:\WerkHome`. The archive has no version folder inside it: extract its contents directly into this Home. Keep the ZIP outside the Home and replace `VERSION` below with its actual version.

```powershell
New-Item -ItemType Directory -Path C:\WerkHome
Set-Location C:\WerkHome
Expand-Archive -LiteralPath C:\Downloads\werk-VERSION.zip -DestinationPath C:\WerkHome
node .\worker.mjs
```

On Linux/macOS, extract the verified archive into the empty Home and run `node ./worker.mjs`. This uses the prebuilt standalone worker: no npm installation, source checkout or project-local installation is required.

The Home defaults to the directory containing `worker.mjs`, even when invoked from another working directory; `--home PATH` selects it explicitly. Private state is beneath `<home>/state/worker`, new project clones are visible at `<home>/projects/<id>`, and replaceable application files are beneath `<home>/runtime`. The launcher starts the worker in the background and opens its webview. It does not start the Factory fleet or enroll an Orchestrator. Use `--no-open` when a browser should not be launched.

After startup and project registration, the Home is directly inspectable:

```text
WerkHome/
  worker.mjs
  werk.mjs
  docs/
  runtime/
  projects/<project-id>/
  state/worker/
```

`projects/` contains worker-owned Git
repositories; `state/` contains private credentials, journals and worktrees;
`runtime/` contains the prebuilt implementation. Keep `state/` private and do not
edit runtime files to configure a project. For an existing 0.16 installation,
follow the [explicit adoption guide](../how-to/project-worker.md#existing-standalone-installations)
before starting a second worker against the same work.

## 2. Open the webview and finish setup

The startup result prints the worker URL and its private `credentialsFile` path. Open that URL and unlock locally using the token in that file. Keep the token outside browser URLs, requests and Git. The printed credential path is not the credential value.

In **Settings → Provider connections**, choose Claude Code CLI and the intended authentication mode, inspect its executable/login diagnostics, and check the connection. Review allowed file/command/MCP tools and required project checks. A successful login check does not prove a model call succeeded or grant tool access.

Open **Projects → Add a project**, then choose **Clone and add project**. Clone the configured remote into the visible Home project directory. Choose the
repository/branch, watched Feature Request folder (default `features`) and poll
interval (default 30 seconds; allowed 1–300 seconds). New project
registration does not adopt an arbitrary existing checkout. Registration does not opt into GitHub APIs even when the remote URL is hosted on GitHub.

Choose the registered project from Projects. Its **Workflow files** stage opens
`/project?project=<id>&step=workflow`. Use **Preview project workflow setup** to inspect the exact target baseline, generated paths and file contents. Approve the displayed commit/push confirmation, then choose **Commit and push project setup**. Existing project files are preserved. After the Git handoff is confirmed, continue to the project's **Policy approval** stage, choose **Approve this exact
policy**, then continue to **Enable requests** and choose **Recheck project setup**
to enable intake. This workflow setup includes `localMerge: true` and leaves GitHub integration absent.

A preview or saved policy draft is not a commit, a push or policy approval. A stale checkout, unknown push result, missing template or unapproved policy remains a visible setup hold. Retained legacy project locations stay visible at their verified paths; registration
does not relocate or duplicate them. GitHub integration remains off unless explicitly configured and approved.

Existing project-installed state is outside standalone Home adoption. If a saved
project configuration belongs to that installation, the new launcher refuses it;
use the old runtime for recovery/export rather than enabling a second watcher.

## 3. Create the Feature Request in the webview

Open **Workboard → New Feature Request** (`/requests/new`), select the registered project and one of its committed templates, and describe a small observable change. Choose Low, Medium or High priority; Low is the default. Include acceptance criteria, approved file scope, a verification plan and relevant context.

Choose **Prepare request**, inspect the resulting draft and use its readiness check. In shared mode, **Save draft to Git** retains unfinished authoring; **Mark ready and publish** commits/pushes the ready request. The worker executes only after the shared handoff and claim are confirmed. New Home project work uses the shared Git authoring/claim handoff; it is not a
generic local-chat submission.

If preparation/readiness reports a blocker, resolve it on that same request. A saved draft does not invoke an implementation model, and a local save alone is not shared publication.

## 4. Observe implementation and Git updates

Choose the request from Workboard. Its existing conversation opens in a focused
request view (`/request?session=<id>`); pre-admission shared requests use the exact
project/request query instead. Open Review when its current candidate needs a
decision. Required checks and pending human acceptance are separate facts. The **Delivery progress**, **Retained Git checkpoints** and **Request activity**
disclosures show the persisted phase, candidate/evidence identities and required next action. Use **Worker updates** to open the request review from its notification. Inspect Git commit/push observations and the original Feature Request's generated status rather than treating a notification alone as proof of completion.

The worker prepares an isolated worktree, retains its start prompt, invokes the approved provider and runs independent checks. Shared Git uses committed requests, claims, progress and review handoffs; pull the watched branch in another clone to inspect those Markdown updates. The worker's execution workspace is separate from the main checkout it may later merge into.

Answer questions through the request's conversation or supported Markdown Task answer. Feedback, questions and retries keep the same Feature Request identity. Failed checks can enter bounded repair; missing/stale evidence or an unknown process outcome remains a visible hold. Closing the webview does not stop the worker.

## 5. Review the delivered increment

When verification produces a reviewable increment, choose **Review increment**.
Inspect the diff, independent checks, manual criteria and current human decision
first. Technical delivery progress and request activity remain available in
disclosures. Inspect the Markdown pull-request handoff for its exact candidate,
branch and evidence. This PullRequest is a Markdown artifact; it does not require
or imply a hosting-service PR.

Use **Request changes** when correction is needed. The worker retains candidate-bound feedback and fresh verification before the next review. Shared feedback must be acknowledged on the remote source before another implementation dispatch. Changed scope or an incompatible source may require an explicit successor request.

Record the required human outcomes for the exact current candidate. A model statement that tests passed cannot replace independent check evidence, and acceptance for an earlier candidate does not authorize changed code.

## 6. Explicitly allow merge into the main checkout

In the request's **Merge into main checkout** area, inspect the merge destination: local repository path, target branch and current head. Confirm this is the checkout you intend to change. A worker-owned clone may have its own main checkout beneath the worker home; approval does not update another developer clone elsewhere.

Keep that displayed checkout on its target branch and clean: commit or otherwise resolve your own staged, unstaged or untracked changes before authorizing integration. The worker refuses a dirty/conflicted checkout, changed destination/head or stale candidate. It does not force-reset or discard your work to make a merge succeed.

After reviewing the exact current increment and recording any required human outcomes, confirm **I approve merging this reviewed candidate into this project’s main checkout on <branch>**, then choose **Merge reviewed candidate into main checkout**. The worker retains the reviewed candidate and expected main head before changing Git refs/worktree files. Wait for a confirmed local-merge receipt, then inspect the main checkout's resulting commit and files. Non-fast-forward/conflicting work is validated against the current main branch; the old candidate cannot silently replace newer main commits. Only frozen permitted workflow-metadata differences may accompany the verified candidate. If main has other source/configuration changes, refresh/rework and verify against current main before asking for another merge.

The confirmed local merge does not push main automatically; shared request/progress/review pushes are separate observed Git operations. It does not update another clone elsewhere.

A Markdown handoff or candidate acceptance alone is not proof of merge. If acknowledgement is lost, choose **Reconcile main checkout merge** to observe the saved local merge read-only before requesting another mutation. A stale view needs a fresh review/command identity, not a retry that silently adopts another main head. A partial checkout/ref interruption may remain unknown with files preserved; reconciliation cannot discard or automatically repair them. Inspect the saved state before another action.

The [plain-Git merge reference](../reference/worker-release-workflow.md#explicit-main-checkout-merge) describes the equivalent guarded CLI actions and their exact candidate/destination fields. These local actions are separate from the optional GitHub host merge.

Before submitting the next shared increment, explicitly publish/synchronize the resulting main commit so the accepted remote baseline contains it. Refresh/reprepare or replace requests authored against an older baseline; a held admission is protection against implementing on code that omits the accepted increment. The worker retains confirmed merge request history in this version to preserve that evidence and blocks its deletion.

With the newly generated `localMerge: true` policy, review acceptance alone leaves delivery in progress until this local merge is confirmed. Older policies without that requirement preserve their earlier review-completion behavior.

## 7. Stop and restart from the same home

Use the same Home launcher, or pass the same explicit `--home`:

```powershell
node .\worker.mjs status
node .\worker.mjs stop
node .\worker.mjs
```

The saved project/request/evidence identities remain associated with that home. Inspect pending operations after restart; repeat an acknowledged command with the same immutable identity, and reconcile unknown outcomes before another mutation. A wait timeout or missing notification does not authorize duplicate submission.

For runtime replacement, inspect `node worker.mjs update plan --from VERIFIED_CANDIDATE_HOME`
and apply only that exact plan with `--if-match PLAN_ID` and explicit `--stop` if
needed. Do not extract another archive over this Home; its projects and private
state are not replacement payload. See [Home updates](../reference/updates.md#central-worker-home).

For extra hosting-service automation, explicitly configure and approve [GitHub candidate publication](../how-to/publish-worker-candidates.md) and the [optional GitHub Release workflow](../how-to/deliver-worker-release.md). A repository URL, installed `gh`, provider login or project registration does not enable those integrations.
