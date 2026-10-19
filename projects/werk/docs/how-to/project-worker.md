# Install a worker in a project

Use the prebuilt worker from a verified Werk runtime release. The project does not
need npm dependencies or a Git checkout. Native operation requires Node 24; Docker
operation requires Docker Engine/Desktop with Compose. Use one runtime at a time
for the same worker state.

Download without starting the default Factory fleet by adding `--no-start` to the
release installer: `node werk-install.mjs --no-start`. Then use the verified
extracted release's worker app below. Downloading the source-code archive is not
this prebuilt installation path.

## Set up with Node

From your project directory, point at the worker in the extracted release:

```sh
node /path/to/werk-release/bin/apps/worker/cli.mjs init
```

This copies the self-contained app to `bin/apps/worker` and creates:

- `.env`: private local access token and worker launch defaults.
- `.env.example`: credential-free keys/placeholders suitable for the team.
- `.werk/worker.json`: feature-folder and default-provider configuration.
- `.werk/worker-project.json`: project startup defaults.
- `.werk/compose.worker.yaml`: a standalone Docker worker.
- `features/_templates/feature-request.md`: an editable shared request template with the chosen provider.
- `.werk/feature-workflow.json`, ready/done check files, an Obsidian Base and an offline Create Feature Request kit.
- Private `.werk/worker` state and `.werk/provider-home`, with Git ignore entries.
- Project agent skills for Claude Code and Codex, plus the Codex supporting guide,
  where those files are missing. Existing edits are preserved and reported.

See [project agent integrations](project-agent-integrations.md) for invocation,
inspection and guarded synchronization. These skills do not start work automatically.

Choose another folder/provider/port at setup:

```sh
node /path/to/werk-release/bin/apps/worker/cli.mjs init --features-dir requests/features --provider openai-api --port 4201
```

If you already copied `bin/apps/worker`, run `node bin/apps/worker/cli.mjs init`.
Repeat setup from the installed app; it preserves configuration and template edits.
Setup refuses to overwrite a different installed app. Upgrade it in place with
`node bin/apps/worker/cli.mjs update apply --stop`, which verifies the release, backs
up the worker state and keeps the previous folder for rollback; see
[update a copied app](../reference/portable-apps.md#update-a-copied-app).

Start from the project directory:

```sh
node bin/apps/worker/cli.mjs run
```

The worker discovers the project configuration and opens its local listener on
port 4100 (or the chosen port). Continue with the CLI-based
[shared Git setup](shared-feature-intake.md#connect-the-worker) to connect a
provider and the team queue. The CLI reads its local credential file itself.
The browser is optional: open the printed URL and unlock with
`WERK_WORKER_TOKEN` from the private `.env` to use the same worker controls.
The token is never printed or placed in the URL. `run` stays in the terminal;
Ctrl+C closes the worker.

Edit the project `.env` to configure `WERK_WORKER_HOST`, `WERK_WORKER_PORT`,
`WERK_WORKER_STATE_DIR` or `WERK_WORKER_CONFIG`. Explicit CLI launch options win;
process environment overrides the file. Relative environment paths are rooted in
the project. Existing private settings, including an enrolled orchestrator
connection, keep their documented precedence. See
[project environment files](../reference/configuration.md#project-environment-files)
for all keys and token rotation.

Setup preserves existing values and never prints credentials. Keep `.env` private
and untracked; commit only `.env.example` if useful for the team. To adopt an
existing installed worker without repeating installation, run
`node bin/apps/worker/cli.mjs env init --state-dir /absolute/worker-state`.
Use that worker's real state directory to retain its access token. Stop and restart
after an intentional token/configuration change.

For background operation:

```sh
node bin/apps/worker/cli.mjs start
node bin/apps/worker/cli.mjs status
node bin/apps/worker/cli.mjs feature list
node bin/apps/worker/cli.mjs stop
```

## Review the detected project repository

If the project directory is itself a Git checkout, run `repository status` and
review the discovered path, branch and remote. Supply its returned `discoveryId`
to the reviewed `shared setup` plan, or use `repository accept --discovery-id ID`
for a separate assignment. Detection alone does not authorize fetching, pulling
or task worktrees. The choice survives restart. In the optional webview, the
same choice is **Use this Git repository?** → **Use repository** or **Don’t use**;
a skipped repository can be accepted later in **Settings → Repositories**.

Accepting adds a saved assignment. A checkout with a branch and remote starts
watching (unless the worker was initialized with `--intake local` or you pass `--watch false`); without a remote, or with detached HEAD, watching starts off. Committed
files remain usable for worktree tasks. Configure a remote/current branch before
enabling watching. Finish queued/running work before accepting. A Git checkout
in a parent directory is not automatically offered, and linked worktrees with a
`.git` file are supported. An existing explicit assignment already authorizes use.

Complete this choice before submitting a feature-folder patch request for the
detected checkout. Chat and tasks for other assigned repositories remain available.
For the equivalent noninteractive commands, see
[worker repository and profile commands](../reference/runtime-cli.md#worker-repositories-and-execution-profiles).

## Assign Git repositories

In **Settings → Repositories**, open **Manage repository assignments** and add
each existing checkout.
Give it a stable ID, its path on the worker machine, and its remote/branch policy.
Enable watching to fetch and safely fast-forward clean checkouts. Drain queued
and running tasks before changing assignments.

Before the first start, you can seed the same assignments in
`.werk/worker.json` with a top-level `repositories` object. Preserve its
`features` settings. Saved private settings take precedence on later starts.
See [repository configuration](../reference/configuration.md#assigned-git-repositories)
for the JSON example, polling limits, status/sync API and retention behavior.

In **New request**, expand **Repository files · optional**, enable **Allow changes
to approved repository files**, and select an assigned repository and paths.
The same **Create request** action captures committed files in a task worktree
beneath that repository's `.werk/worktrees` directory and returns a review patch.
If project tools such as a vault linter scan that folder, set
`repositories.worktreeDirectory` to a short absolute folder outside the checkout.
Deleting a file task removes its clean, verified worktree; changed or protected
worktrees remain available for inspection. `worktrees list` and
`worktrees prune --dry-run` find retained worktrees. Feature-folder patch
requests still target this installed project's directory; include it among the
assignments when using that intake. Requests without file approval have no task
worktree. Optional command and stdio MCP grants can separately select an assigned
live checkout; see [Chat tool directories](manage-model-tools.md#run-chat-tools-in-a-repository-checkout).
Mock execution remains simulated. Every task still has
a generated Markdown progress record, with or without file permission. It lives
under the configured feature folder's `_tasks/` directory; source intake notes
remain separate. See [automatic task tracking](../reference/feature-requests.md#automatic-task-tracking).

The default project Docker image includes Git. Custom images must also provide
Git. Mount every assigned checkout writable. Enter container paths; the generated Compose file
only mounts the installed project by default. Native host paths and Git login
access are not automatically usable in the container. Existing generated Compose
files are preserved by repeat setup; update their image explicitly to a reviewed
Git-capable image when adopting repository tasks.

Native workers use the operator account's Git configuration and retain its proxy,
CA and `SSH_AUTH_SOCK` settings through the native line/system launchers. Set up
Git authentication for that account before starting; the worker does not prompt
for credentials. Keep the SSH agent available for the worker's lifetime.

## Keep the project root tidy

By default `init` writes `Feature Requests.base`, `fr-ready-check.json` and
`fr-done-check.json` to the project root, uses `feature-reviews/` and
`feature-tasks/` for review and task notes, and creates a root `package.json`
when none exists. Two options change that for a new setup:

```sh
node /path/to/werk-release/bin/apps/worker/cli.mjs init --workflow-dir Vault/Workflows --no-npm
```

- `--workflow-dir DIR` places `DIR/Feature Requests.base`, `DIR/reviews`,
  `DIR/tasks`, `DIR/checks/fr-ready-check.json` and `DIR/checks/fr-done-check.json`
  there; the Base's folder filters follow. `DIR` must be a project-relative subfolder
  outside `.werk`, `.git`, `bin`, `node_modules` and the feature folder. `feature setup
  --workflow-dir DIR` does the same without installing a worker.
- `--no-npm` skips the root `package.json`; the result reports `npm: { skipped: true }`.
  Run commands with `node bin/apps/worker/cli.mjs ...` instead of `npm run worker:...`.

An existing `.werk/feature-workflow.json` always wins. If `--workflow-dir` names other
locations, setup reports a `workflow_directory_mismatch` warning with both and moves
nothing; edit the file and move the files yourself. Setup also appends only the
`.env` and `!.env.example` rules that `.gitignore` lacks, so your own rules are not
duplicated; the result lists them as `ignoreAdded`.

## Choose or change the feature folder

Choose the folder during setup with `init --features-dir requests/features`.
For an installed project worker, inspect or change the saved path without editing JSON:

```sh
node bin/apps/worker/cli.mjs feature folder get
node bin/apps/worker/cli.mjs feature folder plan --path requests/features
node bin/apps/worker/cli.mjs stop
node bin/apps/worker/cli.mjs feature folder set --path requests/features
node bin/apps/worker/cli.mjs start
```

`plan` previews the change without writing. `set` moves the existing feature
folder, including requests, results, templates and ownership, and saves the new
project-relative path. Choose a destination that does not already exist; folders
are never merged. The path must stay inside the project, outside `.werk`, `.git`,
`bin` and `node_modules`, and must not contain or be inside the current folder.
Spaces work when quoted. Add `--project-dir /path/to/project` when configuring
from elsewhere. The saved path is shared by native and Docker startup.

For Docker without host Node:

```sh
docker compose --env-file .env -f .werk/compose.worker.yaml down
docker compose --env-file .env -f .werk/compose.worker.yaml run --rm --no-deps worker node bin/apps/worker/cli.mjs feature folder set --path requests/features
docker compose --env-file .env -f .werk/compose.worker.yaml up -d
```

Stop the worker before changing the path; do not start it or edit its configuration
while the command runs. If interrupted, `feature folder get` shows the pending
destination. Verify the old command/process has stopped, clear its stale
`.werk/worker/worker.lock` only if necessary, then repeat `set` with that destination.
Project startup remains blocked until the interrupted change is completed.
For a temporary launch override, `run --features-dir PATH` remains available;
`feature folder get` shows the saved default, while `feature list` shows the active
watcher's directory.

## Submit your first shared request

Connect [shared Git intake](shared-feature-intake.md) before using the installed
team template. Review, commit and push the generated authoring kit and workflow
files. From any clone containing that kit, create a draft:

```sh
node .werk/authoring/feature-request.mjs create --name search.md --title "Find matching requests"
```

Fill in Goal, Context, Acceptance criteria and Verification plan, and approve the
project-relative `paths`. Keep the explicit provider set by setup, or select a
connection configured on the worker. Using the default request folder:

```sh
node .werk/authoring/feature-request.mjs validate --file features/search.md
node .werk/authoring/feature-request.mjs ready --file features/search.md --if-match REVISION
```

Use the successful validation's revision, then commit and push the ready file to
the watched branch. A shared request starts only after that push. The worker
claims it, tracks progress in its original Markdown, and publishes linked Task or
PullRequest notes. Pull updates to read them. An actionable Task's **Answer** and
`status: ready` are the editable response; commit and push the response so the
worker can validate and continue it. Keep the accepted feature body unchanged.

The [team authoring guide](team-feature-authoring.md) covers customization and
Obsidian views. For implementation, configure tool grants and required checks as
explained in [Implement and review a feature](implement-feature.md). A model's
text completion alone does not establish passing project tests.

### Local folder intake without a shared repository

The separate local folder flow accepts requests without `templateId`. Generate
its draft with `feature template`, then use the local management commands below.
Its saves are consumed locally and do not require commit/push. The installed team
template belongs to shared intake and is never silently executed by this watcher.
See the [local proposal tutorial](../tutorials/worker-feature-lifecycle.md) and
[request contract](../reference/feature-requests.md) for this alternative.
For day-to-day operation, including Windows input files and tool limits, use the
[project worker checklist](operate-project-worker.md).

## Set up an operator-only worker

If you only want a local worker that reads requests from its feature folder, with no
shared Git repository or team, initialize it with `--intake local`:

```bash
node /path/to/werk-release/bin/apps/worker/cli.mjs init --intake local
```

The default is `--intake shared`, which changes nothing. With `local`, `init` still
installs the offline authoring kit, and it also:

- writes `features/_templates/local-request.md`: a local request template without
  `templateId`, with `status: draft`, `mode: patch`, your provider, and commented
  `paths` (including a folder entry ending in `/`) and `definitionRef` examples;
- records `features.intake: "local"` in `.werk/worker.json`. A repeated `init` keeps
  it; `init --intake shared` against a local worker stops and names that file, so edit
  or remove the key yourself to switch;
- reports `intake: { mode: "local", template, commands, next }` instead of the shared
  connection steps.

`mode: patch` needs an explicit `paths` list, so copy the template outside the
feature folder and uncomment and edit `paths` first. Then create, check and queue it:

```bash
cp features/_templates/local-request.md request-draft.md   # edit title, paths and body
node bin/apps/worker/cli.mjs feature create --name request.md --markdown request-draft.md
node bin/apps/worker/cli.mjs feature validate --name request.md
node bin/apps/worker/cli.mjs feature submit --name request.md --if-match REVISION
```

Start the worker, then accept the detected project checkout with
`repository accept --discovery-id ID` if tasks should use it. For a local worker the
new assignment is not watched, so nothing is fetched in the background. Pass
`--watch true` to `repository accept` to watch it anyway; `--watch false` also works for a
shared worker. `shared status` and `feature list` carry `intake: "local"` and a hint that
shared intake is intentionally off. To move to shared intake later, set
`features.intake` to `"shared"` (or remove it) and follow
[Submit your first shared request](#submit-your-first-shared-request).
`footprint` and `uninstall` treat the local template as a generated authoring file:
removed when unchanged, kept as your work once edited.

## Start with Docker

After setup, from the same project directory:

```sh
docker compose --env-file .env -f .werk/compose.worker.yaml up -d
```

The generated configuration uses a pinned Node 24 image with Git and the prebuilt app;
there is no npm install or image build. It mounts the project so dropped requests
and results are visible on the host, mounts the app read-only, and binds the
webview to loopback. The container reads the mounted project `.env`; Compose uses
`--env-file .env` for the host-port interpolation. The container listener remains
port 4100. Keep relative project state/config paths or choose paths visible inside
the container. Default private state remains in `.werk/worker`.

```sh
docker compose --env-file .env -f .werk/compose.worker.yaml logs --tail 100 worker
docker compose --env-file .env -f .werk/compose.worker.yaml exec -T worker node bin/apps/worker/cli.mjs feature list
docker compose --env-file .env -f .werk/compose.worker.yaml down
```

The generated user defaults to the setup user's UID/GID. Set `WERK_UID` and
`WERK_GID` when moving the project between machines, and keep the mounted state
writable only by the worker's operator. Set `WERK_WORKER_PORT` to override the host
port. Compose receives a unique project name; separate projects can run independent
workers when their host ports differ.

The stock image has no Claude, Codex or Cursor CLI or host login. Configure an API provider,
or provide a reviewed image with your CLI through `WERK_WORKER_IMAGE` and sign in
as the container's worker account. Host executable paths and host subscriptions
are not automatically transferred. The same applies when switching back to native
operation; update provider paths for that environment. API keys remain private
worker settings. Stop the native process before Docker startup, and stop Docker
before native startup; both runtimes share ownership locks.

## Set up without host Node

You can run the same initializer inside the pinned Node container. On Linux/macOS,
from the destination project (replace the release-app path):

```sh
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=/absolute/werk-release/bin/apps/worker,dst=/installer,readonly" \
  --mount "type=bind,src=$(pwd),dst=/project" --workdir /project \
  node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b \
  node /installer/cli.mjs init
```

On Windows, use Docker Desktop Linux containers and PowerShell:

```powershell
docker run --rm --user 1000:1000 `
  --mount "type=bind,src=C:\werk-release\bin\apps\worker,dst=/installer,readonly" `
  --mount "type=bind,src=$($PWD.Path),dst=/project" --workdir /project `
  node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b `
  node /installer/cli.mjs init
```

Then use the Compose commands above. A native Windows worker can use Claude Code
or Cursor CLI signed in on that machine, or an API provider; Codex CLI remains
POSIX-only. [Cursor setup](use-worker-webview.md#connect-cursor-cli) explains its
native permissions and hooks, which are separate from Werk tool grants.

## Add an orchestrator later

Register through the worker's existing connection settings. New assignments are
written into the same feature folder as frontmatter plus Markdown, with their
orchestrator task/session IDs and current state. They share the same serial
execution slot. Edit the offered IDs/providers in **Settings → Execution profiles**
while paused and idle; see [profile editing](use-worker-webview.md#edit-execution-profiles)
for the supported modes and acknowledgment required after registration. The orchestrator keeps routing and lease ownership; editing an
exported file cannot create a second local execution or alter the remote task.


## Manage local folder requests from a terminal or AI agent

These commands manage the separate local folder flow, which is suspended while
a shared Git binding is saved. For the team template, use the offline authoring
commands above. Otherwise start the worker and prepare a draft outside the watched folder:

```sh
node bin/apps/worker/cli.mjs feature template > request-draft.md
# Edit request-draft.md, keeping status: draft.
node bin/apps/worker/cli.mjs feature create --name search.md --markdown request-draft.md
node bin/apps/worker/cli.mjs feature validate --name search.md
node bin/apps/worker/cli.mjs feature get --name search.md
```

Copy the returned `revision` into the next command:

```sh
node bin/apps/worker/cli.mjs feature submit --name search.md --if-match REVISION
node bin/apps/worker/cli.mjs feature wait --name search.md --timeout-ms 60000
node bin/apps/worker/cli.mjs feature result --name search.md
```

A newly created draft has no accepted execution record yet. After submission and
stable-save admission, the JSON record supplies `taskId` and `sessionId` for follow-up commands. Use
`task send --id SESSION_ID --file follow-up.json` with
`{"message":"Explain the next step."}` to continue that session. For cancellation,
retry, archive or deletion, fetch the current feature revision and use the
corresponding named command. See the [complete management contract](../reference/feature-requests.md#cli-management-contract).

No browser is required for provider setup: `settings set --file provider.json`
accepts `{"provider":{"id":"codex-cli","executable":"/absolute/path/to/codex"}}`.
Authenticate that CLI on the worker machine, then run `provider check --id codex-cli`.
API connections use their provider ID, model and `apiKey` in a private JSON input
file or stdin; keep credentials out of command arguments and project commits.
For shared team work, connect the [Markdown queue](shared-feature-intake.md) and
follow its [overnight handoff](shared-feature-intake.md#work-during-the-day-implement-overnight).

Inspect `settings get` for redacted configuration. `queue pause` stops new
execution and orchestrator claims while running tasks finish; `queue resume` resumes it. Use
`queue configure --file queue.json` for capacity and routing intake settings.

## Remove a project worker

Run every step from the project directory, not from inside `bin/apps/worker`.
First list what the worker owns or created. `footprint` is read-only and works
while the worker runs or is stopped:

```sh
node bin/apps/worker/cli.mjs footprint
```

It groups paths as `app` (`bin/apps/worker`), `retained` (`bin/apps/.worker-update`
and `.werk/worker.updates` from updates), `state` (`.werk/worker`, `.werk/provider-home`
and the worker's owner and status files in the feature folder), `configuration`,
`authoring` (workflow, Base, checks, prompts, template and `.werk/authoring`),
`requests` (feature, review and task folders), `integrations` (agent skills, the
Codex guide, their ownership record and a generated `package.json`), `environment`
(`.env` key names, the `.env.example` block, `.gitignore` rules) and `worktrees`.
Each entry shows its path, whether it exists, its size and whether Git tracks it.
Task worktrees come from the same ownership records as `worktrees list`, with
their state, including those under **Task worktree folder** outside the checkout.
The output never contains file contents or credentials.

Preview the removal, then apply exactly that plan:

```sh
node bin/apps/worker/cli.mjs uninstall --dry-run
node bin/apps/worker/cli.mjs uninstall --confirm
```

Without `--dry-run` or `--confirm` the command refuses. `--confirm` requires a
stopped worker; pass `--stop` to stop a native worker gracefully first, or stop a
Docker worker with `docker compose --env-file .env -f .werk/compose.worker.yaml down`.
It removes clean task worktrees this worker owns through the same checks as
`worktrees prune`, then integration files, authoring files, configuration, state,
retained folders and finally the app folder.

What stays:

- Every Git-tracked file. Commit their removal separately if the team no longer
  needs the kit.
- Request folders. `--include-requests` removes their untracked files, including
  local drafts and results.
- `.env` and the `.env.example` block. `--include-environment` removes only the
  worker keys and block; other lines stay and `.gitignore` is never changed.
- Files you edited, such as a changed skill, Base or check, and integration files
  Werk does not own.
- Task worktrees with uncommitted or untracked changes, commits, an operator lock,
  links or junctions, an invalid record or another assignment. The result lists
  each with its reason; review them before `git worktree remove PATH`.
- Links, junctions, nested Git repositories or submodules (any folder with a
  `.git` entry), any folder that holds a task worktree that stays, and anything
  outside the project directory.
- The whole state directory when its top level holds anything the worker does not
  write (only names such as `webview-token`, `workspace-settings.json`,
  `portable.json`, `portable.log`, `worker-*.sqlite` and its `-wal`/`-shm` files,
  `snapshots/`, `outbox/` and `sessions/` count), or when it contains other project
  files. The result lists the unknown entries as `unknownEntries`. This protects
  you from a mistaken `--state-dir` or `WERK_WORKER_STATE_DIR` such as `.werk` or
  a data folder.
- `.werk/.gitignore` and `.werk/worker-project.json`, while any state, provider
  home, retained or integration path they protect still exists, whether the plan
  keeps it or its removal was incomplete. Resolve the reported paths and run
  `uninstall --confirm` again.

`--dry-run` predicts these keeps, including nested repositories and the two guard
files, so its `remove` and `keep` lists match what `--confirm` does unless files
change in between. `--include-environment` rewrites `.env` through a temporary
`.env.tmp-*` file next to it, which it removes again on failure.

Git tracking is compared without regard to case wherever Git ignores case, as on
Windows, so a file committed as `Features/request.md` counts as tracked in
`features/`. The worker lock stays in place until the last step, so the worker
cannot start during removal.

The CLI removes its own app folder last. If another process, such as a shell,
editor or `npm --prefix bin/apps/worker`, holds it open, the result reports
`ok: false` and names the manual step, for example
`Remove-Item -Recurse -Force bin\apps\worker` on Windows.
