# Operate Werk from an agent or script

Use explicit commands and structured results. An extracted release needs no
interactive installer, npm install, source build or provider account for its mock
runtime. Node 24 is required only for the native launcher; the Docker wrappers
need Docker/Compose and their shell.

## Start and inspect without opening a browser

For a new native state:

```text
node werk.mjs setup --json
node werk.mjs start --json
```

Start stays in the foreground. Supervise that process, parse its JSON-line
lifecycle events and wait for `ready` before submitting tasks. Other operator
commands produce one result object:

```text
node werk.mjs status --json
node werk.mjs doctor --json
node werk.mjs stop --json
```

Pass the same `--state-dir` to every command if you override the default. Check
both exit status and `ok`; preserve an error's `code` and safe diagnostic text.
See [runtime CLI](../reference/runtime-cli.md) for framing and exit codes.

Docker automation uses the equivalent setup/start/status/stop actions on
`bash werk-docker.sh` or `./werk-docker.ps1`; use `--no-open` for unattended start.
Docker start detaches after readiness; check `ready` and the exit status rather
than expecting native lifecycle JSON lines or an `ok` field. Docker errors are
reported on stderr with a nonzero exit. Its `cli` action invokes the bundled orchestrator client with the deployment's
connection and credential mapping. For example:

```text
bash werk-docker.sh cli task list --limit 100
bash werk-docker.sh cli workers list --limit 100
```

## Call the native application CLI

The prebuilt client is `src/orchestrator/dist/orchestrator/cli.js` beneath the
release root. Set `WERK_URL` to the selected line URL and supply `WERK_ADMIN_TOKEN`
from the private credentials file in the **child process environment**. Read the
file inside your trusted runner without printing it or putting its value in
command arguments, prompt text or shell history. Then run:

```text
node src/orchestrator/dist/orchestrator/cli.js task list --limit 100
node src/orchestrator/dist/orchestrator/cli.js workers list --limit 100
node src/orchestrator/dist/orchestrator/cli.js task create --file - --key first-feature-001
```

The last command consumes one JSON object on stdin:

```json
{"project":"demo","requirementRef":"[[Features/Customer portal]]"}
```

To target another assigned Git checkout for native Codex work, include
`"repository":"docs"` while retaining the configured line `project`. The value
is a worker assignment ID, not a path or URL. The native note-input form accepts
`--repository docs` alongside `--project` and `--wikilink`; file/stdin input carries
that field inside its JSON. MCP `werk_task_create` accepts the same optional field.
Without it, repository selection falls back to the task project. Existing pinned
context verification still applies to the selected checkout.

Use an unchanged idempotency key and payload to retry an uncertain submission;
use a new key only for a deliberately new task. Read the returned task ID, then
inspect it with `task get --id TASK_ID` and `task events --id TASK_ID --limit 100`.
CLI stdout is JSON and diagnostics use stderr. Follow `nextCursor` while
`hasMore` is true; a single page is not a complete inventory.

Do not mistake this client for the native runtime operator: `werk.mjs` controls
the local services, while the application CLI calls their authenticated HTTP
interfaces. Workers enroll with a different credential and retain their own
identity. Never grant a coding agent provider credentials merely to operate the
mock runtime.

## Inspect readiness and diagnostics

For a Factory hierarchy, use the [system operator](../reference/system-definition.md)
with one YAML definition and consistent state selection. Its native foreground
JSON stream includes lifecycle and `service_log` records; wait for `event: ready`
and route nested `entry` diagnostics separately. Select `--log-output stream`
to receive nested line/worker diagnostics without mandatory local supervisor
logs, or `both` to keep rotating files as well. Native environment defaults are
specified in [configuration](../reference/configuration.md); explicit flags win. Do not assume every record is a
readiness result or forward unvalidated child stderr into prompts.

Read line capabilities through the authenticated `/v1/capabilities` endpoint or
`overview` result, and bounded worker detail through `/v1/workers/:id`. Check
observation timestamps and truncation flags. Task input must use that line's
configured project. Worker `/healthz` returns 503 while disconnected even though
`/status` remains 200 for diagnosis. Preserve generated `x-request-id` values when
reporting a failed request; log routes omit identifiers and query contents.

The [monitoring procedure](monitor-runtime.md) covers native log paths and Docker
Compose collection; [observability reference](../reference/observability.md)
defines fields and retention. No external alerting or tracing server is started.

## Maintain safely

Inspect status before changing configuration; stop before backup or upgrade.
Follow the [backup procedure](upgrade-backup.md) and keep private state outside
source control. Report unavailable evidence as unknown. A `simulated` task is not
a successful code delivery. Refer to [modes](../explanation/modes.md) and
[security](../reference/security.md) when deciding which actions are authorized.
