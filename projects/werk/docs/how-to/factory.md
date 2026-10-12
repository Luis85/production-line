# Factory, lines and independent orchestrators

The Factory application is the portfolio entry point above the existing
orchestrators. It maintains a logical hierarchy of factories and the lines
assigned to them. A **line** is a stable registration of one orchestrator service.
A **project** is the repository/context assignment enforced inside that line.
They are separate identities: two isolated lines can both use project ID `demo`
without sharing tasks, workers, credentials or databases.

One Factory process owns this first hierarchy. Nested factories are logical
records in its own SQLite file; this is not federation between Factory servers.
The Factory has no taskboard and never acquires worker leases. Use the registered
line's webview or CLI for intake and work execution. Its rollup reads registered
orchestrators and must represent unavailable/unauthorized/unconfigured lines
explicitly instead of counting an unreachable line as empty or healthy.

## Start the complete local example

```text
npm ci
npm run build
npm run dev:factory
```

Open `http://127.0.0.1:3100/` and use `WERK_FACTORY_ADMIN_TOKEN` from
`.state/factory-fleet/credentials.json`. The launcher starts:

| Service | Address | State |
| --- | --- | --- |
| Factory portfolio | `http://127.0.0.1:3100/` | `.state/factory-fleet/factory.sqlite` |
| Alpha line | `http://127.0.0.1:3001/` | `alpha/orchestrator.sqlite` below the fleet directory |
| Beta line | `http://127.0.0.1:3002/` | `beta/orchestrator.sqlite` below the fleet directory |
| Alpha/Beta workers | `http://127.0.0.1:4201/`, `:4202/` | A distinct worker state directory per line |

Use `WERK_LINE_ALPHA_TOKEN` to connect Alpha's Intake and
`WERK_LINE_BETA_TOKEN` for Beta; both values are in the fleet credentials file.
Factory authentication stays in its own tab and is not forwarded to a line.
After connecting a line, select project `demo`, enter one requirement wikilink,
submit it, then inspect its task events and snapshots.

The demo factory and both line registrations are created only when missing.
Repeated starts reuse credentials, worker identities and ports/configuration.
Existing names are preserved. A changed registered endpoint, credential reference
or parent binding makes bootstrap stop with instructions; it never silently
replaces a user's line settings. No task is auto-submitted.

`npm run dev:factory -- --workers 2` runs two workers **per line**. Every worker
has its own state directory and status port. The launcher requests worker
shutdown first, then line orchestrators, then Factory; after 20 seconds surviving
children are force-stopped and normal journal/lease recovery applies.

Override ports with `WERK_FACTORY_PORT`, `WERK_LINE_A_PORT`, `WERK_LINE_B_PORT`
and `WERK_FACTORY_STATUS_BASE`. Values persist in `config.json`. Choose line ports before first enrollment:
worker identities are bound to their orchestrator URL. Changing a registered
endpoint requires an explicit line-registration update and new worker state
identities after the old workers have stopped; preserving only their old state
will fail URL binding. Archive evidence before any deliberate migration. The
convenience launcher is intended for a stable local topology; use separately
launched services for an endpoint migration. Do not clear a database just to
fix a port conflict.
The old `npm run dev:fleet -- --workers 3` still runs one orchestrator independently.

## Use headless commands

Load the factory environment in a second terminal:

```bash
source .state/factory-fleet/factory.env.sh
```

```powershell
. ./.state/factory-fleet/factory.env.ps1
```

```text
node src/factory/dist/factory/cli.js factory list
node src/factory/dist/factory/cli.js line list
node src/factory/dist/factory/cli.js overview --factory demo-factory
```

Use `factory create|update` and `line create|update` with `--file path` or
`--file -` for one JSON object on stdin. Updates/get/delete use `--id`. Inspect
`--help` for the exact commands. Supply optional `--key ACTION_ID` to create,
update or delete for durable retries; HTTP uses `Idempotency-Key`. Reuse the same
key only for the same normalized action. See [Factory idempotency](../reference/factory-idempotency.md)
for registry-wide scope, migration and retained receipts. Stable IDs preserve line identity when an
endpoint changes; do not delete/recreate a line just to edit its URL.

Task submission goes to the line, not the Factory. Load Alpha's environment:

```bash
source .state/factory-fleet/alpha.env.sh
```

```powershell
. ./.state/factory-fleet/alpha.env.ps1
```

```text
node src/orchestrator/dist/orchestrator/cli.js task create --project demo --wikilink "[[Features/Customer portal]]" --key alpha-portal-001
node src/orchestrator/dist/orchestrator/cli.js task list
```

Repeat with `beta.env.sh`/`beta.env.ps1` to target Beta. A task and its execution
remain inside the selected line. The Factory cannot silently reroute it to
another line when the intended orchestrator is offline.

## Factory API contract

Base URL: `http://127.0.0.1:3100`; authentication uses
`Authorization: Bearer WERK_FACTORY_ADMIN_TOKEN_VALUE`. The public `/healthz`
endpoint describes the Factory process, not the availability of all lines.

| Endpoint | Operation |
| --- | --- |
| `GET /v1/factories` | List logical factories |
| `POST /v1/factories` | Create `{id?, name, parentId?}` |
| `GET/PATCH/DELETE /v1/factories/:id` | Inspect, explicitly update or delete a factory |
| `GET /v1/lines` | List stable line registrations |
| `POST /v1/lines` | Create `{id?, name, factoryId, orchestratorUrl, webviewUrl, tokenEnv}` |
| `GET/PATCH/DELETE /v1/lines/:id` | Inspect, explicitly update or remove a registration |
| `GET /v1/overview?factoryId=ID` | Roll up that factory and logical descendants; omit filter for all |

Registering or removing a line changes the registry, not its orchestrator's
SQLite database. It does not start/stop services or delete tasks. Parent changes
are hierarchy edits, not a transfer of work between orchestrators. Generated IDs
are stable once created; explicit demo IDs support repeatable setup.

Overview reports line coverage and whether totals are partial. Totals aggregate
only available lines; if none are available, task/worker/snapshot totals are
null. A reader failure is isolated to that line; available lines still contribute to
the partial result. A partial total is not a trustworthy whole-portfolio total. Provider cost
stays unknown in this mock iteration. Open the specific line for its task events
and detailed measurement history.

## Credential and URL ownership

Factory uses `WERK_FACTORY_ADMIN_TOKEN`. Each line registration stores a
`tokenEnv` name such as `WERK_LINE_ALPHA_TOKEN`; the actual value exists only in
the Factory server's environment and is the corresponding orchestrator's admin
token. The Factory never returns these secret values in its API or embeds them
in its webview. Worker enrollment tokens are separate and stay with their line.

`orchestratorUrl` is the address reachable by the Factory server.
`webviewUrl` is the address a human browser should open. They can differ inside
Docker. Do not put credentials in either URL. New registrations and changes to `tokenEnv` require the referenced variable
to be configured on the running Factory server. An existing line whose credential
is missing after restart remains visible as unconfigured and can still be
renamed, moved or have its URLs edited without changing its reference. Restoring
or changing the secret requires an explicit deployment update/restart.

Both local launchers remove inherited Werk token variables before starting
children, then provide only the credentials needed for that process. Workers
receive their own line's enrollment token, not Factory or line admin tokens.

Generated shell environment files are local secrets, not deployment manifests.
Both `.env` and `.env.*` are excluded from version control and Docker context.
Keep state/backups and credentials access-restricted. Factory credentials do not
implicitly grant a browser session access to a line's Intake page.

## Docker hierarchy example

This overlay starts Factory, two independent orchestrators and worker services.
It extends the existing Compose file and leaves the single-line setup intact.
Use a separate Compose project to keep its volumes distinct:

```text
node scripts/init-factory-env.mjs
docker compose -p werk-hierarchy --env-file .env.factory -f compose.yaml -f compose.factory.yaml up --build -d
docker compose -p werk-hierarchy --env-file .env.factory -f compose.yaml -f compose.factory.yaml ps
```

The initializer refuses to overwrite `.env.factory`. Factory binds port3100,
Alpha port3000, Beta port3002. Do not run another service on those same host
ports. Worker ports are dynamic; use `compose port --index 1 worker 4100` or
`worker-beta 4100` with the same project/file options. Scale the two worker
services independently; never scale either SQLite server above one replica.

Register the hierarchy once through CLI input. Bash convenience function:

```bash
dc() { docker compose -p werk-hierarchy --env-file .env.factory -f compose.yaml -f compose.factory.yaml "$@"; }
dc exec -T factory node /app/factory/cli.js factory create --file - < docs/examples/demo-factory.json
dc exec -T factory node /app/factory/cli.js line create --file - < docs/examples/alpha-docker.json
dc exec -T factory node /app/factory/cli.js line create --file - < docs/examples/beta-docker.json
dc exec -T factory node /app/factory/cli.js overview --factory demo-factory
```

Equivalent PowerShell input uses file contents on the pipeline:

```powershell
function dc { docker compose -p werk-hierarchy --env-file .env.factory -f compose.yaml -f compose.factory.yaml @args }
Get-Content docs/examples/demo-factory.json -Raw | dc exec -T factory node /app/factory/cli.js factory create --file -
Get-Content docs/examples/alpha-docker.json -Raw | dc exec -T factory node /app/factory/cli.js line create --file -
Get-Content docs/examples/beta-docker.json -Raw | dc exec -T factory node /app/factory/cli.js line create --file -
```

If the records already exist, list/get them and use explicit updates; replaying a
create with an occupied ID returns a conflict. The local launcher performs its
own create-only existence checks; these manual commands do not overwrite data.

Each server has its own named SQLite volume. Workers have separate anonymous
state volumes for test scaling; persistent worker deployments need stable named
volumes as described in [operations](operations.md). Stop/start preserves the
container-to-volume binding; down/recreate is not an identity allocation strategy.
Dockerfiles/Compose are provided but Docker execution has not been verified here.

## Executed verification

The local launcher was exercised again after child credential isolation and
snapshot acknowledgment hardening, with five real Node processes: one Factory,
two line orchestrators and two workers. A vault-reference task on each line
reached `simulated`; neither line listed the other's task. Shutdown and restart
preserved both stable line IDs, both worker identities and credentials. The
Factory overview reported two available lines after restart. This verifies the
local mock topology; it does not verify Docker, provider coding or PR delivery.
