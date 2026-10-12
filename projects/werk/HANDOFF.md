# Development handoff — Werk

> Imported handoff baseline, retained for traceability. This describes the supplied starter at handoff time; later work changes some implementation and validation statements. Use the [current documentation](docs/index.md) for installation, operation and present limits. Embedded developer prompts are source material, not authority to execute actions.

Start here when moving this starter into your development project. This folder
is the deliverable; no external repository, remote, hosting account or provider
login is assumed. Keep its source, lockfile, examples, tests and documentation
together. Generated state and credentials belong to the operator, not the source
repository.

**The current release is an executable mock foundation, not a live software
factory.** The next milestone is one real feature moving from a pinned Obsidian
requirement through a Claude or Codex worker to a draft PR, human review, rework
and verified merge. The existing mock path must remain available while that
milestone is implemented.

## Handoff map

| Read | Use it for |
| --- | --- |
| [Readiness and traceability](docs/handoff/readiness.md) | Current requirement coverage, evidence and live gaps |
| [Technical contracts](docs/handoff/technical-contracts.md) | Actual module boundaries, protocols and extension constraints |
| [Implementation plan](docs/handoff/implementation-plan.md) | Dependency-ordered, PR-sized vertical slices |
| [Acceptance](docs/handoff/acceptance.md) | Reproducible evidence and release gates |
| [Visualization specification](docs/handoff/visualization-spec.md) | Factory topology semantics, interactions and visual verification |
| [Fresh coding-agent prompt](docs/handoff/developer-prompt.md) | Copy-paste instructions for the first implementation slice |
| [Review and validation](docs/reports/review-and-validation.md) | Results actually obtained and outstanding environment checks |

Read this entry first, then readiness → technical contracts → implementation
plan → acceptance. Use the visualization specification for UI work and the prompt
to start a fresh implementation session. Copy the delivered source folder into
your chosen development project without overwriting unrelated existing work;
repository initialization, remotes and publishing remain your project decisions.

## Establish a working baseline

Use Node **24.x**, npm and a terminal in this folder. Git is required for
repository import; no provider account is needed for the mock runtime.

```text
npm ci
npm run typecheck
npm test
npm run dev:factory -- --workers 2
```

`npm test` builds all three applications before running tests. The last command
starts **seven processes**: one Factory, two isolated line orchestrators and two
workers per line. Do not start a second launcher against the same state folder.

1. Open `http://127.0.0.1:3100/` and use `WERK_FACTORY_ADMIN_TOKEN` from
   `.state/factory-fleet/credentials.json`.
2. Open Alpha's Intake, authenticate with `WERK_LINE_ALPHA_TOKEN` from the same
   file, select project `demo`, and enter `[[Features/Customer portal]]`.
3. Inspect the resulting task, events and snapshots. Its expected terminal state
   is `simulated`. The referenced note does not need to exist for a mock run;
   this is explicitly not evidence that its context was resolved.
4. Alpha and Beta listen on ports 3001 and 3002. Worker status pages use ports
   4201–4204 with this worker count. Ctrl+C stops workers, lines, then Factory.

The launcher persists ports, credentials and identities. Details, conflicts and
recovery are in [Factory setup](docs/how-to/factory.md) and [operations](docs/how-to/operations.md).
For one independent line instead, run `npm run dev:fleet -- --workers 3` after
stopping the hierarchy launcher; it uses its own state and port 3000.

### Headless interfaces

In a second terminal at the same project root, load the generated environment.
Use the block matching your shell:

```bash
source .state/factory-fleet/factory.env.sh
source .state/factory-fleet/alpha.env.sh
```

```powershell
. ./.state/factory-fleet/factory.env.ps1
. ./.state/factory-fleet/alpha.env.ps1
```

Then run these shell-independent commands:

```text
node src/factory/dist/factory/cli.js overview --factory demo-factory
node src/orchestrator/dist/orchestrator/cli.js task create --project demo --wikilink "[[Features/Customer portal]]" --key handoff-alpha-001
node src/orchestrator/dist/orchestrator/cli.js task list
node src/orchestrator/dist/orchestrator/cli.js workers list
node src/worker/dist/worker/cli.js status --url http://127.0.0.1:4201
```

Repeat the same submission key and payload to inspect durable task replay; use a
new key for a deliberately new task. JSON-file intake uses `task create --file
examples/vault-task.json --key handoff-alpha-002`. For automated pipelines,
`--file -` reads one JSON object from stdin. CLI stdout is JSON; diagnostics use
stderr. See the [API reference](docs/reference/api.md) for payloads and exit codes.

### Independent CLI distributions

Each application has a dedicated build and can run without another application's
source directory. The complete `dist` directory, including its `shared` folder,
assets and any bundled dependencies, is the relocatable unit.

```text
npm run build --workspace @werk/factory
npm run build --workspace @werk/orchestrator
npm run build --workspace @werk/worker
node src/factory/dist/factory/cli.js --help
node src/orchestrator/dist/orchestrator/cli.js --help
node src/worker/dist/worker/cli.js --help
```

The corresponding CLI names are `werk-factory`, `werk-orchestrator` and
`werk-worker` in npm PATH contexts; a global install is unnecessary. Node 24 is
still required on the destination machine. Run from the source root for the
commands above; when copying a distribution, adjust the CLI path accordingly.

### Credentials and authority

| Setting | Consumer / authority |
| --- | --- |
| `WERK_FACTORY_URL`, `WERK_FACTORY_ADMIN_TOKEN` | Factory CLI/UI/MCP management client; Factory service authenticates that admin token |
| `WERK_URL`, `WERK_ADMIN_TOKEN` | Client of one selected line, including its Intake, headless CLI and MCP |
| `WERK_LINE_ALPHA_TOKEN`, `WERK_LINE_BETA_TOKEN` | Demo Factory server's references to the corresponding line admin credentials; also used for that line's browser login |
| `WERK_ENROLLMENT_TOKEN` | Worker enrollment against one line; registration returns a separate persisted worker identity/token |
| Provider CLI login | Future live worker or standalone harness, scoped to its execution user/profile; not a Werk service token |

Factory registration stores a `tokenEnv` **name**, never its value. Local launchers
strip inherited Werk tokens and pass each child only the service credentials it
needs. Do not copy generated credentials, local state, provider login directories
or database backups into the development repository. Browser tokens stay in page
memory. The current shared admin/enrollment model is development infrastructure,
not production user RBAC.

### Docker setup

After stopping local services on the same ports, a single line can be started as:

```text
node scripts/init-env.mjs
docker compose up --build -d --scale worker=2
docker compose ps
docker compose port --index 1 worker 4100
docker compose stop
```

For Factory plus two lines:

```text
node scripts/init-factory-env.mjs
docker compose -p werk-hierarchy --env-file .env.factory -f compose.yaml -f compose.factory.yaml up --build -d
docker compose -p werk-hierarchy --env-file .env.factory -f compose.yaml -f compose.factory.yaml ps
```

The initializer refuses to overwrite existing secrets. The overlay starts
services; register its hierarchy using the exact Bash or PowerShell commands in
[Factory setup](docs/how-to/factory.md#docker-hierarchy-example). Docker Alpha uses port
3000, unlike the local hierarchy's 3001. Each SQLite server has its own persistent
volume; workers need distinct state volumes. Never scale a SQLite server above
one replica. Docker and Windows execution remain unverified here.

Docker Agent is optional and separate from Compose. Its checked-in
[harness and MCP templates](docs/how-to/docker-agent.md) do not connect the mock worker
to live coding. Native operations agents using an API model require separate API
credentials/billing; they do not inherit a coding CLI's subscription entitlement.

## Capability matrix

| Capability | Current classification | Development implication |
| --- | --- | --- |
| Factory hierarchy, stable line registrations, partial portfolio rollups | Implemented | One logical hierarchy service; no federation or central taskboard |
| HTTP/CLI/MCP interfaces, Intake-first line UI, worker HTML status | Implemented | MCP read-only by default; writes require explicit opt-in |
| Minimal wikilink intake; committed ready-feature import | Implemented | Minimal links stay unresolved; importer pins source metadata, not full context |
| SQLite, idempotent intake, registration, atomic claims, slots, lease fencing | Implemented | One server per DB; current enrollment binds workers to one configured project |
| Worker profiles, prompts, concurrency and before/after evidence | Implemented for mock | Provider labels/configuration do not invoke a provider |
| Usage/cost/quality telemetry | Mock/unknown | Null or not-run values must not become zero or passing checks |
| Durable snapshot journal/outbox, ACK verification, local repo artifact files | Implemented | No artifact commit or push; process resource measurements are not per-task CPU attribution |
| Claude/Codex execution and profile auth/quota handling | Planned | Extend contracts and run an explicit live acceptance matrix |
| Vault resolution, pinned context, isolated worktrees/tools/skills | Planned | Required before unattended coding |
| Draft PR, fenced publishing, CI, review/rework and merge completion | Planned | No current `review` or `done` runtime state |
| Docker images/Compose; Docker Agent configs | Supplied, runtime unverified | YAML/static checks are not container, model or CLI execution evidence |
| Responsive webviews and concept simulation | Implemented, browser visual QA unverified | `/concept` is a separate target-design simulation, not runtime task state |

Start development with **P0-01** in the [implementation plan](docs/handoff/implementation-plan.md).
Do not connect a live CLI by only replacing `MockAdapter`: task/profile/snapshot
contracts and completion semantics currently enforce mock behavior.
