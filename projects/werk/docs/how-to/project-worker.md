# Set up projects in WerkHome

Werk runs from one central Home. A project contains its Git-tracked workflow and
source; it does not need an installed worker, private runtime credentials or a
copy of the application. The new runtime refuses project-local `init`.
Start with [archive to main checkout](../tutorials/worker-home-to-main.md).

## Set up with Node

Extract a verified runtime archive directly into an empty Home and run
`node /path/to/WerkHome/worker.mjs`. Node 24 and Git are required; provider CLIs
need their own installation and authentication. The launcher anchors Home to its
own directory regardless of the shell's current directory. Fresh private state
is `Home/state/worker`, application payload is `Home/runtime`, and new cloned
projects are `Home/projects/<id>`.

Open the printed URL, unlock using the printed private credential-file path,
and configure the provider. Use the webview for project registration and setup.
No project `package.json`, npm installation, `.env` or runtime copy is required.

## Assign Git repositories

Open **Projects → Add a project**. Clone the configured remote into the visible
`Home/projects/<id>` directory. New registration does not adopt arbitrary existing
checkouts. Choose the watched Feature Request folder and polling interval.
Registration never grants GitHub API integration.

For a worker-owned clone, preview the missing workflow files and exact target
branch; approve **Commit and push project setup** only after inspecting that
preview. Separately approve the exact committed delivery policy, then recheck
project setup. Existing custom workflow files are preserved. The generated policy
requires explicit local-main merge confirmation and leaves GitHub integration off.
Existing retained legacy locations remain at their verified paths.

## Review the detected project repository

The Home directory is not implicitly your project. Choose or register the exact
repository in Projects. Review its absolute checkout path, branch, setup status
and intake mode. A legacy registered clone can remain outside `Home/projects/`;
the view identifies that retained location rather than silently moving it.

## Keep the project root tidy

Keep replaceable code in `Home/runtime/`, private worker internals in
`Home/state/`, and visible worker-owned repositories in `Home/projects/`.
Project workflow files remain normal committed Markdown/configuration. Worktrees,
provider state and journals belong to the worker's private effective state path.

## Choose or change the feature folder

Choose the project's feature directory during registration and commit its
workflow configuration. Existing requests and accepted evidence retain their
saved paths. Changing a path is not migration: do not move a watched queue or
retained evidence while work is active. Inspect the saved project/setup view and
resolve any drift before enabling intake again.

## Submit your first shared request

After setup, choose **Workboard → New Feature Request**. Prepare, inspect and mark
it ready using the project's committed template and checks. Shared mode commits
and pushes its request; claim confirmation precedes implementation. Follow
[shared Git intake](shared-feature-intake.md) and the
[primary tutorial](../tutorials/worker-home-to-main.md).

### Local folder intake without a shared repository

New Home projects use shared Git authoring and claims. Retained local request
records are not a new project-installation path. Their source semantics remain
documented in [the request contract](../reference/feature-requests.md).

## Set up an operator-only worker

Use the same central Home, register the remote project and configure
its provider/tool permissions. A single-operator setup does not require copying
an application into the source repository. Review and acceptance retain exact
candidate identity; GitHub remains an optional approved extension.

## Existing standalone installations

Do not extract over a running or populated installation. Keep the old runtime,
repositories and a verified backup. Extract the new archive into a fresh Home.
Only legacy standalone Home state is eligible for adoption. Project-installed
state with sibling `.werk/worker.json` or `.werk/worker-project.json` startup
configuration is refused; use that matching
old runtime for recovery/export. The old `.werk/worker` state can contain absolute
paths; adoption preserves those
paths and does not move/copy journals, repositories, worktrees or provider state.

Use the new Home launcher to inspect bounded discovery or select an exact state:

```powershell
node C:\WerkHome\worker.mjs migration plan
node C:\WerkHome\worker.mjs migration plan --state-dir C:\OldHome\.werk\worker
```

Stop the old worker using its old CLI and exact state path before adoption:

```powershell
node C:\OldHome\werk-0.16.0\bin\apps\worker\cli.mjs stop --state-dir C:\OldHome\.werk\worker
node C:\WerkHome\worker.mjs migration adopt --state-dir C:\OldHome\.werk\worker
node C:\WerkHome\worker.mjs
```

Substitute the real paths; older workers may have stored state inside the
version folder or a project checkout. `migration plan --state-dir` makes that
selection explicit. Adoption writes the private `Home/state/home.json` selection;
it is not a relocation or a fresh clone. The selected legacy state and registered
checkout paths remain where they were. Preserve them after adopting.

Multiple populated states, live locks and unverifiable process/lock ownership
block startup or adoption. Inspect/recover the old worker first; do not delete
locks merely to start a competing worker. No automatic relocation or project-local installation migration is provided. The new runtime does not run
project-local `init` or regenerate the old installation.

## Start with Docker

The retired project-local Compose installer is not the new Home setup path.
Use the maintained [independent component deployment guide](assemble-independent-components.md)
for explicit container state and repository mounts. Do not mount one state into
competing native and Docker workers.

## Set up without host Node

Use the [Docker deployment guide](assemble-independent-components.md); the native
Home launcher itself requires Node 24. Downloaded applications are prebuilt.

## Add an orchestrator later

Connect an independently running Orchestrator in **Settings → Orchestrator**.
Enrollment does not transfer project ownership or opt into live host integration.
See [independent components](assemble-independent-components.md).

## Manage local folder requests from a terminal or AI agent

Advanced automation uses the full prebuilt CLI at
`Home/runtime/bin/apps/worker/cli.mjs`. Always pass `--state-dir` with the exact
effective state path: fresh `Home/state/worker` or the retained path selected by
adoption. Raw CLI commands do not resolve the Home selection for you. Offline
`feature setup --project-dir PATH` remains an authoring-kit operation; it does not
install a worker. See [the CLI reference](../reference/portable-apps.md).

## Remove a project worker

`footprint` and `uninstall` remain legacy recovery tools, not Home installation
instructions. Inspect the old installation with its matching runtime and a backup
before choosing removal. Preserve tracked/edited project files, credentials,
requests, unknown worktrees and retained evidence; do not infer that adopting
state makes its old parent directory disposable. Never uninstall an active or
adopted state without first stopping the worker and resolving its ownership.
