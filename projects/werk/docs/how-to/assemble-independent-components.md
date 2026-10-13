# Assemble independent components

Start only the components you need, then connect them through their webviews.
A worker accepts tasks through Chat and prepares local review patches without
an orchestrator. It executes exactly one task at a time; a larger queue does not
increase that limit. Only workers prompt LLMs.
An orchestrator can own a production line without Factory. Factory registers
existing lines and routes work to them; it does not start their processes.

Native commands run from an extracted release with Node 24, each as a foreground
process in a separate terminal. Docker examples use the same prebuilt release
without host Node. No npm install or source checkout is required. The examples
use one machine,
loopback addresses, separate state directories and distinct ports.

For individually copyable app folders and background lifecycle commands, use the
[portable Node apps](../reference/portable-apps.md) interface.

## Start a worker

```sh
node werk.mjs worker run --state-dir .werk/components/demo-worker --status-port 4201
```

Open `http://127.0.0.1:4201`. Unlock it using the private
`.werk/components/demo-worker/webview-token` file. Chat is the default;
History contains local tasks and evidence, and Dashboard contains monitoring,
provider settings and optional orchestrator enrollment. Configure a provider
there to submit model-backed tasks. Configuration alone does not verify login,
subscription quota or model access. See [Use the worker webview](use-worker-webview.md)
for provider setup and the separate local Run task workflow.

Without explicit options, worker state is `.state/worker` and its port is 4100.
Starting standalone does not require an enrollment token.

## Scale with separate workers

Each worker is serial across Chat, file tasks and remote assignments. Start more
worker instances for parallel execution. Keep their identities, task sessions,
credentials and state separate even when they share a host or provider account.

### Native: two workers, two terminals

From the extracted release, run one command per terminal:

```sh
node werk.mjs worker run --state-dir .werk/components/worker-a --status-port 4201
```

```sh
node werk.mjs worker run --state-dir .werk/components/worker-b --status-port 4202
```

Open `http://127.0.0.1:4201` and `http://127.0.0.1:4202`. Each directory contains
its own `webview-token`. Configure providers and optional enrollment separately.
These are alternatives to the first example: stop its worker or choose unused
ports before starting them. Do not raise a per-worker parallelism setting.

### Docker: two workers, two persistent volumes

From an extracted release, build its prebuilt runtime image with Docker; host
Node and npm are not required:

```sh
docker build --file Dockerfile.release --tag werk-runtime:local .
```

Run the bundled worker CLI in two containers. Each command is a single line and
works with Bash or PowerShell:

```sh
docker run --detach --name werk-worker-a --publish 127.0.0.1:4201:4100 --mount type=volume,source=werk-worker-a,target=/state --entrypoint node werk-runtime:local /app/src/worker/dist/worker/cli.js run --state-dir /state --status-host 0.0.0.0 --status-port 4100
docker run --detach --name werk-worker-b --publish 127.0.0.1:4202:4100 --mount type=volume,source=werk-worker-b,target=/state --entrypoint node werk-runtime:local /app/src/worker/dist/worker/cli.js run --state-dir /state --status-host 0.0.0.0 --status-port 4100
```

Use the same two browser addresses as the native example. The `0.0.0.0` listener
is inside each container; the published host ports remain loopback-only. Inspect
each private `/state/webview-token` in its container to unlock that worker. The
named volumes retain separate state when containers are stopped or replaced.

```sh
docker stop --time 20 werk-worker-a werk-worker-b
docker start werk-worker-a werk-worker-b
```

The runtime image does not install or authenticate Codex/Claude subscription
CLIs. Configure an available API connection on each worker, or supply a separately
prepared CLI-enabled image and login. Do not assume a host CLI login exists inside
a container. These commands start standalone workers; enroll each later through
Dashboard using an orchestrator address reachable from that container. Container
`127.0.0.1` is the container itself, not the host or another container. See
[Manage access](manage-access.md) for deliberate remote-listener/HTTPS setup.

For a complete Docker hierarchy, the separate
[system-YAML workflow](../tutorials/system-from-yaml.md) creates one worker
container per configured `workers.count`. The single-line Docker `setup/start`
wrapper accepts `--workers 1`; it is not a standalone-worker scaling command.

## Start an orchestrator and enroll the worker

In another terminal:

```sh
node werk.mjs orchestrator run --state-dir .werk/components/demo-line --port 3001 --project demo
```

Open `http://127.0.0.1:3001` and sign in with `adminToken` from the private
`.werk/components/demo-line/component.json`. The default authenticated page is
**Dashboard** (`#system`), with Intake, Taskboard, Worker and metrics alongside.
Choose **Tour starten** to explore the process, routing and evidence views.

In the worker's **Dashboard → Provider connections & orchestrator enrollment**,
enter `http://127.0.0.1:3001` and the orchestrator's `enrollmentToken` from the
same `component.json`, then choose **Save & connect**. The worker retries
registration when the service is unavailable. Its project comes from the
enrollment grant. A configured chat provider does not change its registered
execution profiles; the default orchestrated profiles remain simulations.

The orchestrator runs without any enrolled worker: tasks wait for an eligible
claim. Its default state directory is `.werk/orchestrator`, port 3000 and project
`demo`. `--project` seeds the first start; an existing directory cannot be reused
for a different project. Worker CLI enrollment is also available through
`--url` and the `WERK_ENROLLMENT_TOKEN` environment variable.

## Start Factory with a private line credential

Factory needs a server-side line credential for summaries, delivery and the
interaction proxy. In the terminal that will start Factory, set
`WERK_LINE_DEMO_TOKEN` to the orchestrator's `adminToken`, using your shell's
private environment setup or secret manager. Do not paste a secret into a
command that will be retained in shell history. For example, in Bash, run these
commands and paste only the token when `read` waits for input:

```sh
read -r -s WERK_LINE_DEMO_TOKEN
export WERK_LINE_DEMO_TOKEN
node werk.mjs factory run --state-dir .werk/components/demo-factory --port 3100
```

The token is read without terminal echo. Factory captures the configured
`WERK_LINE_*_TOKEN` variables at startup; restart it with the appropriate
environment after adding or rotating a line credential. Use a separate variable
for each line. Never substitute Factory's own login token for a line token.

Open `http://127.0.0.1:3100`. Sign in with `adminToken` from
`.werk/components/demo-factory/component.json`. Factory's default state directory
is `.werk/factory` and its default port is 3100. Each independent service creates
and reuses its private `component.json`; keep those files, databases and worker
state out of source control and release program files. Launch output names the
credential file without printing its contents.

## Register the line in the browser

In Factory, create a root Factory using **Fabrik anlegen**, then register the
existing orchestrator using **Produktionslinie registrieren**. Set:

| Field | Example |
| --- | --- |
| Line name | Demo line |
| Owning Factory | The root you created |
| Orchestrator URL for the Factory server | `http://127.0.0.1:3001` |
| Webview URL for your browser | `http://127.0.0.1:3001` |
| Line credential environment variable | `WERK_LINE_DEMO_TOKEN` |

The last field holds the variable name, never its token value. With components
on separate machines, use addresses reachable by the caller: Factory reaches
the orchestrator, the orchestrator reaches the worker for chat, and the browser
uses the webview URL. The default listeners bind to loopback; remote deployments
need deliberate listener and trusted HTTPS/access configuration. See
[Manage access](manage-access.md).

Factory opens its aggregate dashboard for the selected hierarchy scope. Choose
a line in **Dashboard** to open its dedicated dashboard (`#line=<id>`), including
process counts, a 3D/2D map, interaction and **Orchestrator öffnen**. A dedicated
line view is scoped to that line; unavailable or stale observations remain
explicit. **Tour starten** and **Linien-Tour** are replayable walkthroughs.

## Submit work and choose routing

In **Factory-Intake & Auftragsrouter**, select a Factory, project, provider and
execution mode. Enter a requirement link, or a title and acceptance criteria,
then save the task. **Simulation** is the default. Explicit live Codex work
requires compatible native execution and committed context; see
[Run a Codex task](run-codex-task.md). A saved request is not completed work.

Factory persists intake independently of a line's task queue. Its list shows the
newest 100 records and total queued, delivering and delivered counts. Routing
uses the selected Factory and its descendants:

- **Automatic:** require recent compatible project, intake/context, provider and
  execution-mode observations plus free eligible capacity. Prefer the greatest
  observed capacity, then the smaller queue. Missing or stale capability data
  leaves work waiting.
- **Manual:** select a default line or a per-task destination. The chosen line
  must still be reachable and compatible, but can accept queued work without
  observed free slots. A manual policy with no target waits for a selection.
- **Pause deliveries:** retains stored work and stops dispatch while paused.
  It does not stop tasks already accepted by an orchestrator.

Dispatch checks pending intake every two seconds while Factory runs. Before its
first send it persists the exact destination and payload. If acknowledgement is
lost, it retries that destination with the same `factory:<intake-id>` idempotency
key, even across restart; it does not silently send the task to another line.
You can change a queued destination only before delivery has begun. `delivered`
means the line acknowledged its task ID, not that execution or review finished.
Inspect the task in the owning orchestrator for progress. Registrations referenced
by intake history or pending work cannot be removed.

In the orchestrator Dashboard, open **Auftragsrouting konfigurieren**. Automatic
routing admits eligible workers using project, provider, execution mode and
compatible profiles and available capacity, preferring lower relative load.
Each worker still executes at most one task; accepted queue places are not
additional execution slots. Manual routing targets a selected registered worker; a manual policy without a worker
waits. Task detail can override the target of a queued task. Clearing an override
returns to the current policy. Existing leases do not move when routing changes.
Order can follow worker policy, FIFO or priority. Workers still pull assignments;
the router does not start worker processes or prompt an LLM.

Worker polling defaults to one second plus a small jitter and is configurable.
Extra worker queue places can allow reserved work to wait locally before
execution. Local Chat tasks, file tasks and those assignments all share one
execution slot. Pause holds all new starts while the current task finishes;
accepted waiting assignments do not drain until resumed. Consequently, an
orchestrator's running count includes reserved assignments; the worker distinguishes waiting from executing. Factory dashboard
readings refresh every 15 seconds, orchestrator readings every five seconds and
worker readings every three seconds while visible; these UI refreshes are
separate from server dispatch and worker polling.

## Create a worker task or submit through the router

Choose **Interaktion öffnen** on the line or orchestrator dashboard. Its Chat tab
requires a worker registered with that line, its webview address reachable from
the orchestrator, and its private worker access token. Choose New task and send
the first message to queue work directly on that worker. Follow-up messages use
the same task session. Every Chat task, explicit file task and remote assignment
owns a dedicated session. The widget forwards requests; only the worker prompts
the model. Provider access and transcripts stay owned by the worker. Chat polling
runs every three seconds while the page is visible.

The browser keeps the access token only in the open dialog's memory. Service
proxies use it for that request; URLs and browser storage never contain it.
Closing the widget clears its connection. The selected session is shared with
the worker webview; reconnect if another operator changes it. A connected session
does not verify provider login, quota or cost.

Use **Submit task** as a separate explicit action when work should enter the
line's router rather than the connected worker's local Chat queue. In Factory's line dashboard,
the request enters durable Factory intake with that line selected; in the
orchestrator, it enters the line's own task queue. Worker selection follows the
configured router, not the worker used for conversation. You can also submit
directly through orchestrator **Intake**. Local worker **Run task** remains a
file-input workflow that captures approved paths and produces a review patch.
It has its own task session and waits for the same single worker execution slot.

## Stop and resume safely

Ctrl+C stops each foreground service. Restart with the same command, private
state and required environment to retain identities, sessions, queues and
delivery history. Stopping Factory does not stop a separately running line or
worker. Keep a separate state directory for every instance and never run two
writers against one directory. Independent component launchers reject managed
runtime or worker directories; do not mix them with `setup/start` or system-YAML
state. See [Upgrade and back up](upgrade-backup.md) before moving persistent state.
