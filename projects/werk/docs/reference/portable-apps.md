# Portable Node applications

The runtime release contains `bin/apps/factory`, `bin/apps/orchestrator` and
`bin/apps/worker`. Copy any complete folder into another project's `bin/apps/`.
Each includes its compiled application, webview, CLI and runtime dependencies.
Only **Node.js 24.x** is required. No npm install, source checkout, Docker or sibling
application is needed. CLI subscription providers additionally need their installed,
authenticated executable on a Linux or macOS worker machine. Windows workers use
API providers. API providers need a configured key and selected model.

From the destination project directory:

```sh
node bin/apps/worker/cli.mjs start --state-dir .werk/worker-a --port 4100
node bin/apps/worker/cli.mjs start --state-dir .werk/worker-b --port 4101
node bin/apps/orchestrator/cli.mjs start --state-dir .werk/line --port 3000 --project demo
node bin/apps/factory/cli.mjs start --state-dir .werk/factory --port 3100
```

Start any subset in any order. `start` returns JSON when the app and authenticated
control endpoint are ready; `run` stays in the foreground for CI, systemd, launchd,
Windows services or containers. Use `--port 0` for an available port and read `url`
from the result. Workers open Chat first; Factory and orchestrators open Dashboard.
Startup returns the private credential **file path**, never its contents. Open the
returned URL and unlock the webview using that file locally. The CLI reads local
credentials itself. Workers may enroll later through `settings set`; Factory can
register an already running orchestrator as a line.

## Lifecycle and automation contract

Every app supports `help`, `schema`, `run`, `start`, `status`, `stop`, `health`,
`monitoring` and `api`. Help/schema return a JSON command catalog with HTTP methods,
required flags and example bodies. Successful commands write JSON to stdout;
diagnostics go to stderr. `--json` is optional. Exit 0 means success, 2 means invalid
input or API rejection, and 1 means operational failure. No command prompts or
opens a browser. `status` distinguishes running, stopping, stopped and unreachable;
unreachable exits 1. A running process is not necessarily connected to its upstream.
Use `health` and `monitoring` to inspect application readiness and current conditions.

```sh
node bin/apps/worker/cli.mjs schema
node bin/apps/worker/cli.mjs status --state-dir .werk/worker-a
node bin/apps/worker/cli.mjs monitoring --state-dir .werk/worker-a
node bin/apps/worker/cli.mjs stop --state-dir .werk/worker-a
```

`stop` authenticates the specific instance and drains/cancels work through the
application's shutdown path. It never kills a stored PID. Repeating stop on a stopped
app succeeds. A second start of an already running instance is rejected, so changed
launch options cannot be silently ignored. After a crash, inspect the private log
and verify that the owning process has exited before removing stale lifecycle
metadata and its lock. Never remove locks from a running app.

State defaults to `.werk/<app>` under the invoking project, outside the copied app.
Use a separate state directory and port for each instance. Keep state private and
out of Git; it includes credentials, transcripts, SQLite databases and results.
Detached operational logs are in `<state>/portable.log`; apply your log retention
policy while stopped. To update: stop, back up state, replace the complete app folder
with a verified release copy, then start with the same state and launch options.
The portable CLI does not automatically replace itself. Copying runtime files never
copies provider credentials or task history. Stop all writers before backing up.

## Give a worker tasks from an AI agent or CI

Configure a provider using `settings set --file provider.json`; files and stdin
contain JSON and are limited to 64 KiB. Subscription login takes place with the
provider's CLI on the host. An example settings document is:

```json
{"provider":{"id":"codex-cli","executable":"/absolute/path/to/codex"}}
```

On Windows, configure an API connection instead, for example
`{"provider":{"id":"openai-api","model":"YOUR_SELECTED_MODEL","apiKey":"PRIVATE_API_KEY"}}`,
and use `"provider":"openai-api"` in task input. Keep the configuration file private.

Then write a task document, for example `task.json`:

```json
{"id":"ci-architecture-001","title":"Plan a search page","provider":"codex-cli","message":"Draft acceptance criteria for a search page with filtering."}
```

```sh
node bin/apps/worker/cli.mjs settings set --state-dir .werk/worker-a --file provider.json
node bin/apps/worker/cli.mjs task create --state-dir .werk/worker-a --file task.json
node bin/apps/worker/cli.mjs task get --state-dir .werk/worker-a --id ci-architecture-001
node bin/apps/worker/cli.mjs task send --state-dir .werk/worker-a --id ci-architecture-001 --file followup.json
node bin/apps/worker/cli.mjs task cancel --state-dir .werk/worker-a --id ci-architecture-001
```

`followup.json` contains `{"message":"Describe the next step."}`. Each task owns one
session; follow-ups retain it. Commands address that session directly and do not
change the conversation selected in the browser. Repeating create with the same
explicit ID and original title/provider/message/agent profile returns the existing task; changing
that input conflicts. Omitting ID generates a new task, so do not automatically retry
an ambiguous create without an explicit ID. Follow-up sends are not idempotent;
inspect the transcript before retrying an ambiguous response. Task acceptance does
not mean completion: inspect `session.status`, `chat.busy` and message outcomes.
All chat, file work and remote assignments execute serially. Queue places add waiting
capacity; multiple isolated worker instances provide parallel execution.

For local files use `file-task create --file file-task.json` with an explicit
repository and approved paths:

```json
{"title":"Explain the acceptance rule","instruction":"Add a comment explaining the rule.","provider":"codex-cli","repository":"/absolute/project","paths":["acceptance.txt"]}
```

Inspect `file-task list`, `file-task get --id ID`, or use `file-task action --file`
for taskboard operations. File tasks capture approved input and produce review
patches. They do not apply changes or run tests. `session action --file` supports
rename/archive/delete with the same restrictions as the webview. `settings set`
configures the local queue, provider connections and optional orchestrator:

```json
{"connection":{"enabled":true,"url":"http://127.0.0.1:3000","enrollmentToken":"PRIVATE_ENROLLMENT_TOKEN"}}
```

Use private files or stdin for secrets, never literal credentials in command arguments.
An orchestrator's `component.json` contains separate admin and enrollment tokens.
Only the worker prompts an LLM; higher-level interactions are delegated to a worker.

## Check sign-in and use Docker Agent definitions

`provider check --id codex-cli` (or another provider ID) runs a bounded read-only
CLI sign-in check without prompting a model. API connections report configured
or missing configuration; no paid API request is made. Raw account output is not
returned. Browser access uses its own protected session and is separate from
provider sign-in; bearer-based automation continues to read the private token.

```sh
node bin/apps/worker/cli.mjs provider check --id codex-cli
node bin/apps/worker/cli.mjs definition preview --file preview.json
node bin/apps/worker/cli.mjs definition import --file definition.json
node bin/apps/worker/cli.mjs definition list
node bin/apps/worker/cli.mjs definition delete --id DEFINITION_ID
```

Preview input is `{"yaml":"YAML_TEXT"}`; import adds `"name":"Project reviewer"`.
The returned definition ID can be added to `task create` or `file-task create`
input as `"definitionId":"DEFINITION_ID","agent":"root"`. The task stores an
immutable instruction/model snapshot. Supported OpenAI/Anthropic model references
require a matching worker provider; the definition never silently changes billing.

This is an instruction-profile integration. Preview lists unsupported Docker
runtime features. Only after reviewing them, add `"useInstructionsOnly":true`
to explicitly omit them for the task. Tools, hooks, harnesses, sub-agents, remote
resources and parallel execution are not started. Imports do not expand variables
or load credentials. Each complete JSON request must fit 64 KiB. Definitions stay
in private worker state and persist across restart; all task execution stays serial.

## Manage Factory and orchestrator

Factory commands include `factory list|get|create|update|delete`,
`line list|get|create|update|delete`, `intake list|create|route`, `routing get|set`,
`overview` and `line interact`. Registry mutations require a stable `--key` for safe
retries. Intake creation also requires a key. Example Factory creation:

```json
{"id":"main","name":"Project factory","parentId":null}
```

```sh
node bin/apps/factory/cli.mjs factory create --file factory.json --key factory-main
node bin/apps/factory/cli.mjs factory list
node bin/apps/factory/cli.mjs routing get --id main
```

Before starting Factory, supply each line credential through its named environment
variable, such as `WERK_LINE_ALPHA_TOKEN`, with the orchestrator admin token. Register
a line using `line create --file line.json --key line-alpha`:

```json
{"id":"alpha","factoryId":"main","name":"Alpha","orchestratorUrl":"http://127.0.0.1:3000","webviewUrl":"http://127.0.0.1:3000","tokenEnv":"WERK_LINE_ALPHA_TOKEN"}
```

The Factory reads these credentials at startup; restart it with the new environment
when adding a credential. Registering a line neither starts nor owns its process.
Factory intake bodies contain `factoryId`, `task` and optional `lineId`. Routing
supports automatic capability/capacity matching or manual destinations; without a
compatible live destination intake remains queued. `routing set --id main --file`
accepts `{"mode":"auto","lineId":null,"paused":false}`.

Orchestrator commands include `task create|list|get|events|route`, `workers list`,
`routing get|set`, `overview` and `interact`. Task creation uses `--file` and a stable
`--key`; for example:

```json
{"project":"demo","title":"Implement the requirement","criteria":["Record evidence"],"wikilinks":[],"provider":"codex"}
```

Orchestrator `routing set --file` accepts
`{"mode":"auto","workerId":null,"order":"fifo"}`. No workers are required
to accept queued work. Use `schema` to discover command methods and required flags.

The bounded `api` command exposes other existing endpoints, including pagination:

```sh
node bin/apps/orchestrator/cli.mjs api --path '/v1/tasks?limit=100'
node bin/apps/factory/cli.mjs api --path '/v1/intake?factoryId=main'
```

For remote management use `--url` plus a private plain-text `--token-file` or
`WERK_APP_TOKEN`. An explicit URL never receives automatically discovered local
credentials. Use HTTPS across untrusted networks. API permissions and validation
are unchanged: CLI commands call the same application APIs as the webviews.

## Build and qualify

Maintainers run `npm run build` to create all three `bin/apps/` folders, or
`node scripts/build.mjs worker` for one. Generated apps are ignored by Git and included
in runtime release archives. The packaging integration test copies apps to unrelated
projects, starts independent instances on available ports, uses authenticated commands,
checks private state/restart and exercises worker task sessions with a labelled model
fixture. Fixture success does not qualify authenticated live provider execution.
