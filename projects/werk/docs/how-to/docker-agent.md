# Docker Agent compatibility

Werk provides two integration paths: external coding-CLI **harness templates**
and native Docker Agent **operations agents** using Werk's stdio MCP bridges.
These are distinct from the Compose deployment described in [factory.md](projects/werk/docs/how-to/factory.md).

| Config in `integrations/docker-agent` | Execution/authentication | Werk integration |
| --- | --- | --- |
| `claude-harness.yaml` | Installed Claude CLI and its existing login | Standalone project coding session |
| `codex-harness.yaml` | Installed Codex CLI and its existing login | Standalone project coding session |
| `operations-local.yaml` | Native Docker Agent with an installed Docker Model Runner model | Read-only Factory/line tools over MCP |
| `operations-api.yaml` | Native Docker Agent with OpenAI API credentials | Same read-only MCP tools; separate API billing |

The mock worker is not automatically replaced by these templates. Lease-bound
coding execution, before/after publication, Git push, draft PR creation and
review/merge reconciliation still require the live worker adapter integration.
A standalone harness session must not be counted as a completed factory task.

## Subscription CLI harnesses

Install Docker Agent and the relevant coding CLI. Authenticate that CLI as the
same OS user who runs Docker Agent. Harness configuration omits model overrides
so the CLI's configured choice remains in force. Keep API-key overrides out of
the CLI environment if your intended mode is its subscription login.

```text
docker agent run integrations/docker-agent/claude-harness.yaml --dry-run
docker agent run integrations/docker-agent/codex-harness.yaml --dry-run
```

Then run one selected config with `--working-dir /path/to/project`. The Claude
harness uses the CLI's login; the Codex harness uses its `exec --json` interface.
Docker Agent toolsets attached to harness agents are ignored, so these templates
intentionally have none. Configure MCP inside the external CLI when that CLI
needs Werk tools, or use the separate native operations agent below.

Docker's current Claude harness invokes its CLI with permission prompts bypassed;
Docker Agent's native tool approval hooks do not mediate those internal calls.
Use a trusted checkout and explicit worktree/container isolation where required.
A worktree separates Git changes but is not filesystem isolation. `--sandbox`
does not automatically supply the coding CLI or its login. These constraints
matter before treating a harness as an unattended factory worker.

## Native operations agent with Werk MCP tools

Build Werk and run `npm run dev:factory`. In a second terminal at the starter
root, load Factory and the selected line's environments:

```bash
source .state/factory-fleet/factory.env.sh
source .state/factory-fleet/alpha.env.sh
export WERK_ROOT="$PWD"
export WERK_OPS_MODEL='YOUR_INSTALLED_DMR_MODEL_ID'
docker agent run integrations/docker-agent/operations-local.yaml --dry-run
docker agent run integrations/docker-agent/operations-local.yaml "Inspect line availability and the current task evidence."
```

PowerShell equivalents for the environment setup:

```powershell
. ./.state/factory-fleet/factory.env.ps1
. ./.state/factory-fleet/alpha.env.ps1
$env:WERK_ROOT = (Get-Location).Path
$env:WERK_OPS_MODEL = 'YOUR_INSTALLED_DMR_MODEL_ID'
```

Replace the model placeholder with an actual model installed in Docker Model
Runner. To use an API-backed native agent, explicitly choose `operations-api.yaml`,
set `WERK_OPS_MODEL` to an API model available to your account and configure
`OPENAI_API_KEY`. This API mode is billed separately; a Claude/Codex subscription
login does not authenticate the native model provider. No provider mode changes
silently between these files.

Both native configs start local Node MCP subprocesses using the absolute
`WERK_ROOT`. Their URLs and credentials come from environment variables; no
secret is embedded in YAML. Run the built distribution, not TypeScript source.
The MCP adapters call HTTP and do not read SQLite or expose arbitrary URLs.

## Bridge interfaces

```text
node src/factory/dist/factory/cli.js mcp serve
node src/orchestrator/dist/orchestrator/cli.js mcp serve
```

`--url` can select the service when starting a bridge. Otherwise the Factory
bridge uses `WERK_FACTORY_URL`/`WERK_FACTORY_ADMIN_TOKEN` and the line bridge uses
`WERK_URL`/`WERK_ADMIN_TOKEN`. Standard output is reserved for MCP protocol
messages; diagnostics go to stderr. These commands are subprocess tool servers,
not interactive human command loops or public HTTP MCP endpoints. Clients must
initialize the connection and send the initialized notification before calling
tools; omitted argument objects are empty, while explicit `null` is invalid.

Read-only tools cover Factory/line inspection and overview, plus task lists,
paged events, workers and snapshots. They do not expose worker completion,
lease bypass, shell execution or a generic HTTP proxy. A model's instructions
cannot enable writes on a read-only bridge.

Task, worker and event tools return at most 100 items by default. Their optional
`limit` accepts integers from 1 to 1000 and `cursor` accepts the opaque
`nextCursor` from the same collection (and task for events). Each result includes
`hasMore` and `nextCursor`: keep requesting pages while `hasMore` is true, and
only report the inventory complete after a page has `hasMore: false`. Task and
worker ordering follows the API's stable page order, not changing heartbeat times.
These tools require the paginated Werk API; an older or malformed response
without continuation metadata produces an explicit tool error instead of an
apparently complete inventory. Snapshots retain their separate numeric cursor
contract. Tool discovery schemas and descriptions document these arguments.

Input frames are limited to 64 KiB of UTF-8 JSON before their newline delimiter;
responses are limited to 1 MiB. An oversized response returns a protocol error
with no partial data: retry a read with a smaller limit and the same input cursor.
The bridge processes one request at a time and waits for each stdout write before
reading the next frame. A broken stdout pipe terminates processing without
replaying a tool call or attempting another response. An operator-configured
server binding may resolve and pin task requirement context; clients cannot
supply trusted context metadata, and task execution remains mock only.

For an explicitly authorized management session, start the relevant bridge with
`--allow-writes true` and remove `readonly: true` from a private copy of the
native agent config. The server then exposes supported Factory/line CRUD or task
submission. Mutations require an `idempotencyKey` in their tool arguments. Task
submission uses the orchestrator's durable replay contract. Factory mutations
now persist atomic receipts in their own registry: the same key and normalized
request replay the original result after restart, while changed operation, target
or payload conflicts. See [Factory idempotency](../reference/factory-idempotency.md). Keep the
shipped configurations read-only.

## Verification and compatibility scope

All four YAML files were parsed and their top-level schema/agent structure and
harness/toolset separation checked. The stdio bridges have separate protocol and
HTTP integration tests in the starter. Docker Agent itself, its configuration
loader, model calls, coding CLIs and Docker execution were not run here. The
`--dry-run` commands above are the installation-specific next check, not a claimed
validation result. Pin a tested Docker Agent version for your deployment.

References checked on 2026-10-12:

- [Coding harnesses](https://docker.github.io/docker-agent/features/harnesses/)
- [Agent configuration](https://docker.github.io/docker-agent/configuration/agents/)
- [MCP local-process tools](https://docker.github.io/docker-agent/tools/mcp/)
- [Configuration and environment expansion](https://docker.github.io/docker-agent/configuration/overview/)
- [CLI options](https://docker.github.io/docker-agent/features/cli/)
