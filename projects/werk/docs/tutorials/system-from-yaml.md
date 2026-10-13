# Run a Factory system from one YAML file

You will use one definition to start a Factory with two independent production
lines, open a line from Factory and inspect a simulated task. Choose native or
Docker execution for this exercise; both consume the same YAML structure.

Use a verified, extracted Werk release. Native requires Node 24. Docker requires
Docker Engine 26+, Compose 2.35+ and Bash or PowerShell, without host Node/npm.
The example needs unused ports **3100**, **3001**, **3002**, **4201** and **4202**.

## Inspect the definition

Open [examples/system.yaml](../../examples/system.yaml). It declares:

| Entity | ID/project | Port |
| --- | --- | --- |
| Factory | `demo-factory` | 3100 |
| Alpha line | `alpha`, project `demo-alpha` | 3001 |
| Alpha worker | One configured worker slot | 4201 |
| Delivery subfactory | `delivery-group`, logical child of `demo-factory` | Shares 3100 |
| Beta line | `beta`, project `demo-beta`, parent `delivery-group` | 3002 |
| Beta worker | One configured worker slot | 4202 |

Alpha belongs directly to the root Factory. Beta is grouped beneath the
`delivery-group` subfactory, which shares the same Factory service/webview. Its
system ID is `demo-system` and default environment is `native`. Leave the file
unchanged for this tutorial. No secrets or tasks are stored in it. The
[entity explanation](../explanation/core-entities.md) describes how these IDs relate.

## Native: plan and start

At the release root:

```text
node werk.mjs system plan --file examples/system.yaml --json
node werk.mjs system up --file examples/system.yaml
```

Review the plan before starting. Up prepares private state, starts the Factory,
line orchestrators and workers, then opens the Factory page once all are healthy.
Keep the terminal running. Add `--no-open` for headless use, or use `--json` for
machine lifecycle output. State defaults to `.werk-system/demo-system`. Native
Factory login uses `WERK_FACTORY_ADMIN_TOKEN` from
`.werk-system/demo-system/factory/credentials.json`; Alpha login uses
`WERK_ADMIN_TOKEN` from `.werk-system/demo-system/lines/alpha/credentials.json`.
Read these privately; never print or share the credential file contents.

## Docker: use the same definition

Choose this path instead of the native start above. The explicit environment
override keeps one example file usable for both runtimes. Use a separate state
if you have already initialized it for native execution.

Bash:

```bash
bash werk-docker.sh system plan --file examples/system.yaml --environment docker --json
bash werk-docker.sh system up --file examples/system.yaml --environment docker
```

PowerShell:

```powershell
./werk-docker.ps1 system plan --file examples/system.yaml --environment docker --json
./werk-docker.ps1 system up --file examples/system.yaml --environment docker
```

Wait for the whole system to become healthy. If a browser does not open, visit
`http://127.0.0.1:3100/`. The Factory and each line have separate administrative
credentials. Linux Docker keeps the same private `factory/credentials.json` and
`lines/alpha/credentials.json` hierarchy under its state root. Windows stores it
in a named volume; explicitly export the login files:

```powershell
./werk-docker.ps1 system credentials --file examples/system.yaml --environment docker
```

Read Factory's `WERK_FACTORY_ADMIN_TOKEN` from the exported
`credential-export/factory/credentials.json` and Alpha's `WERK_ADMIN_TOKEN` from
`credential-export/lines/alpha/credentials.json`. The export is private and refuses
to overwrite an existing export directory. Do not put a token in a URL, prompt or
log. Windows execution validation remains separate from Linux container checks.

## Follow one task through Alpha

Sign into Factory with its Factory admin credential. Inspect the Delivery Group
subfactory and its Beta line, then return to the root. Open Alpha from the Factory
view; its Intake is at `http://127.0.0.1:3001/`. Sign in using Alpha's line admin
credential, which is separate from the Factory and Beta credentials.

Verify the Intake project is `demo-alpha`, enter `[[Features/Customer portal]]`
and submit. Open the created task and wait for **simulated**. Inspect the worker,
its attempt, event history and before/after snapshots. Beta's independent queue
is unaffected. The default mock reference does not require a note or repository.

Return to Factory to inspect line availability and the portfolio summary. This
confirms topology, intake and evidence flow; it does not represent code delivery,
a Git push or a real pull request.

## Stop and reuse the system

Native, from a second terminal:

```text
node werk.mjs system status --file examples/system.yaml --json
node werk.mjs system stop --file examples/system.yaml
```

For Docker, use the same wrapper and `--environment docker` with `system status`
and `system stop`. Stop preserves the databases and worker identities. Run the
same `system up` again to reuse them. Sign out of each webview when finished.

Before changing the topology, read [definition drift](../reference/system-definition.md#drift-and-lifecycle).
Before an upgrade or restore, stop every writer and follow the
[backup guide](../how-to/upgrade-backup.md). Each line has its own persisted task
history; changing the YAML does not merge or migrate those histories.
