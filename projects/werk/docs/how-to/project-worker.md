# Install a worker in a project

Use the prebuilt worker from a verified Werk runtime release. The project does not
need npm dependencies or a Git checkout. Native operation requires Node 24; Docker
operation requires Docker Engine/Desktop with Compose. Use one runtime at a time
for the same worker state.

## Set up with Node

From your project directory, point at the worker in the extracted release:

```sh
node /path/to/werk-release/bin/apps/worker/cli.mjs init
```

This copies the self-contained app to `bin/apps/worker` and creates:

- `.werk/worker.json`: feature-folder and default-provider configuration.
- `.werk/worker-project.json`: project startup defaults.
- `.werk/compose.worker.yaml`: a standalone Docker worker.
- `features/_templates/feature-request.md`: an editable draft template.
- Private `.werk/worker` state and `.werk/provider-home`, with Git ignore entries.

Choose another folder/provider/port at setup:

```sh
node /path/to/werk-release/bin/apps/worker/cli.mjs init --features-dir requests/features --provider openai-api --port 4201
```

If you already copied `bin/apps/worker`, run `node bin/apps/worker/cli.mjs init`.
Repeat setup from the installed app; it preserves configuration and template edits.
Setup refuses to overwrite a different installed app. Upgrades follow the
[portable stop/back-up/replace/restart procedure](../reference/portable-apps.md).

Start from the project directory:

```sh
node bin/apps/worker/cli.mjs run
```

The worker discovers the project configuration, watches the feature folder and
opens its local listener on port 4100 (or the chosen port). Open the printed URL
and [connect a provider](use-worker-webview.md#connect-claude-or-codex).
The printed credential file path is local; its token is not printed or placed in
the URL. `run` stays in the terminal; Ctrl+C closes the worker.

For background operation:

```sh
node bin/apps/worker/cli.mjs start
node bin/apps/worker/cli.mjs status
node bin/apps/worker/cli.mjs feature list
node bin/apps/worker/cli.mjs stop
```

## Drop your first request

Copy `features/_templates/feature-request.md` to `features/search.md`. Fill in its
title, goal and acceptance criteria, then change `status: draft` to `status: ready`.
The worker detects the stable save and writes the request's ID and queue state
back into frontmatter. Open `_worker-status.md` to inspect intake errors and the
queue without opening the webview. Read `werk.result`/`werk.patch` for saved output.

You can also generate a new default template from the terminal:

```sh
node bin/apps/worker/cli.mjs feature template > features/search.md
```

Use a new filename: shell redirection replaces an existing file. For coding work,
set `mode: patch` and list approved project-relative files in `paths`. The worker
returns a review patch; inspect it, use `git apply --check`/`git apply` when
appropriate, and run your tests yourself. Chat mode sends only the request body.
See the [request fields, statuses and recovery rules](../reference/feature-requests.md).

## Start with Docker

After setup, from the same project directory:

```sh
docker compose -f .werk/compose.worker.yaml up -d
```

The generated configuration uses a pinned Node 24 image and the prebuilt app;
there is no npm install or image build. It mounts the project so dropped requests
and results are visible on the host, mounts the app read-only, and binds the
webview to loopback. Private state remains in `.werk/worker`.

```sh
docker compose -f .werk/compose.worker.yaml logs --tail 100 worker
docker compose -f .werk/compose.worker.yaml exec -T worker node bin/apps/worker/cli.mjs feature list
docker compose -f .werk/compose.worker.yaml down
```

The generated user defaults to the setup user's UID/GID. Set `WERK_UID` and
`WERK_GID` when moving the project between machines, and keep the mounted state
writable only by the worker's operator. Set `WERK_WORKER_PORT` to override the host
port. Compose receives a unique project name; separate projects can run independent
workers when their host ports differ.

The stock image has no Claude/Codex CLI or host login. Configure an API provider,
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
  node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df \
  node /installer/cli.mjs init
```

On Windows, use Docker Desktop Linux containers and PowerShell:

```powershell
docker run --rm --user 1000:1000 `
  --mount "type=bind,src=C:\werk-release\bin\apps\worker,dst=/installer,readonly" `
  --mount "type=bind,src=$($PWD.Path),dst=/project" --workdir /project `
  node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df `
  node /installer/cli.mjs init
```

Then use the Compose commands above. Native CLI providers remain POSIX-only;
Windows native workers use API providers.

## Add an orchestrator later

Register through the worker's existing connection settings. New assignments are
written into the same feature folder as frontmatter plus Markdown, with their
orchestrator task/session IDs and current state. They share the same serial
execution slot. The orchestrator keeps routing and lease ownership; editing an
exported file cannot create a second local execution or alter the remote task.
