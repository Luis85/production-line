# Test suites

Run `npm test` from the project root with Node 24. The command builds all three applications, then Node expands quoted recursive globs for every `*.test.mjs` and `*.test.cjs` under this directory. `npm run check` also runs TypeScript checking. There is no separate JavaScript test framework or shell-specific recursive glob setting. On Linux/macOS, the infrastructure suite also runs Python 3 archive/readiness regressions through a Node wrapper; install Python 3 for the complete source check. Linux systemd unit validation runs when systemd-analyze is available. These are maintainer checks, not extra requirements for the native downloaded runtime.

| Directory | Concern |
| --- | --- |
| `architecture/` | AST dependency direction, negative boundary fixtures, build-version provenance and domain/adapter separation |
| `factory/` | Factory registry, topology aggregation, isolation and application behavior |
| `infrastructure/` | Portable Linux VM/cloud-init rendering, artifact verification and service supervision contracts |
| `operations/` | Build packaging, fleet startup/shutdown, environment isolation, backup/restore and polling limits |
| `orchestrator/context/` | Vault input, committed context resolution, authorization, provenance, pinned iteration imports and process/restart integration |
| `orchestrator/runtime/` | Task persistence, leasing, HTTP/application boundaries, pagination and legacy iteration import |
| `shared/` | Shared contracts and validation |
| `shared/http/` | HTTP request correlation, safe service diagnostics, worker readiness and bounded native log capture/rotation |
| `shared/mcp/` | MCP tool contracts and stdio/process integration |
| `shared/security/` | Cross-service authentication, request and transport boundaries |
| `ui/concept/` | Standalone concept prototype behavior and layout |
| `ui/runtime/` | Runtime pages, accessibility, sessions, pagination and worker status |
| `worker/` | Execution, lease handling, durable evidence, recovery, retention and pinned-context verification |

Test filenames retain their history; choose a directory by the behavior under test. Cross-service tests live with their primary use case. Some older runtime suites cover iteration import alongside task behavior; a separate importer folder can be introduced when those suites are split by behavior.

For a focused run after `npm run build`, use `node --test "tests/worker/*.test.mjs"` or `node --test "tests/orchestrator/context/*.test.mjs"`. Run commands from the project root: subprocess integration tests intentionally launch the built application CLIs there. File imports and source fixtures resolve relative to each test module. Temporary runtime fixtures use isolated directories and are cleaned up by their tests.

Keep new tests named `*.test.mjs` or `*.test.cjs` so recursive discovery includes them. Preserve real assertions and cleanup when moving tests; do not replace behavioral checks with directory-shape assertions. Mock execution tests do not demonstrate live provider execution.

Portable `start` leaves a detached `_run` process behind after the CLI call returns. A fixture that starts portable apps in a temporary directory registers it with `ownWorkspace(t, directory, stop)` from `helpers/workspace-processes.mjs`. After the test passes, fails or times out, the helper calls `stop`, which should use the app's own `stop` command. It then terminates any process tree whose command line still names that directory (`taskkill /T /F` on Windows), waits until none remain and removes the directory with retries. A detached guard does the same if the test process is killed before its after hooks run. Processes from other directories are never signalled.


## Spatial navigation browser regression

`ui/browser/visual-navigation.mjs` is an explicit Chromium integration check,
separate from the default Node suite. Start an isolated native demo system from
`examples/system.yaml` on its default ports (Factory 3100, Alpha 3001), and save
at least two simulated tasks in Alpha using Intake. Do not use a production state
directory. Install Playwright Core outside the project or provide its module path:

```sh
WERK_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
WERK_CHROMIUM=/usr/bin/chromium \
WERK_VISUAL_STATE=/absolute/path/to/demo-state \
WERK_VISUAL_REPORT=/tmp/werk-visual-report.json \
node tests/ui/browser/visual-navigation.mjs
```

If `playwright-core` is resolvable, its module override can be omitted. The script
reads generated credentials into memory, tests mobile touch/keyboard panning,
route history, focus restoration and a delayed response race, and emits a sanitized
JSON result. Worker assignments and delayed responses use browser route fixtures;
the script does not change persisted tasks. Keep the isolated system running for
the check and stop it afterward with `system stop --state-dir`.

## Repository intake and walkthrough browser regression

[ui/browser/repository-intake.mjs](ui/browser/repository-intake.mjs) uses the same
isolated mock system as the spatial check above. It saves one simulated Factory
intake and one simulated line task; do not point it at production state. Workers
must have mock profiles for this fixture. Credentials stay in process memory.

```sh
WERK_VISUAL_STATE=/absolute/path/to/demo-state \
WERK_VISUAL_EVIDENCE_DIR=/tmp/werk-intake-browser \
node tests/ui/browser/repository-intake.mjs
```

The installed Playwright package is the default; `WERK_PLAYWRIGHT_MODULE` and
`WERK_CHROMIUM` can override the browser runtime. Optional
`WERK_VISUAL_FACTORY_URL`, `WERK_VISUAL_LINE_URL` and `WERK_VISUAL_LINE_ID`
default to Factory 3100, Alpha 3001 and `alpha`. The check verifies repository
ID validation, live-mode provider selection, actual simulated task submissions,
assignment display, draft preservation, German nonmodal tours, background access,
Escape focus restoration and responsive overflow at 1440 and 390 pixels. It saves
screenshots and a sanitized JSON result, without invoking a live provider.

## Worker access and taskboard browser qualification

After `npm run build`, run [worker/webview-smoke.mjs](worker/webview-smoke.mjs)
with Playwright Core and Chromium available. This explicit integration check
is separate from the default Node suite. It starts and cleans up its own worker
on an allocated loopback port and uses a labelled model protocol fixture.

```sh
WERK_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
WERK_CHROMIUM=/usr/bin/chromium \
WERK_BROWSER_EVIDENCE=/tmp/werk-worker-browser \
node tests/worker/webview-smoke.mjs
```

The module path defaults to the workspace browser-runtime installation when
present. Evidence defaults to a new temporary directory. The script tests unlock,
reload, provider checks, definition preview/import/adaptation, task creation with
its first message, per-task drafts, follow-ups, queue controls, checkpoint answers,
Board/List/search, history links, patch-review deep links, code copying, inert HTML,
tour and keyboard navigation, responsive overflow, restart recovery and Lock.
It saves desktop, tablet and mobile screenshots, a representative taskboard view
and a JSON result without credentials. Provider output and the proposed file patch
come from a labelled protocol fixture; no real provider login or model request is
performed, and the approved checkout is left unchanged.

## Project worker and feature-folder qualification

The default suite includes `worker/feature-requests.test.mjs` and
`operations/project-worker.test.mjs`: stable saves, drafts, duplicate IDs, admission
recovery, folder ownership, malformed input, preserved Markdown, serial execution,
project installation and actual native CLI restart. Native provider execution uses
a labelled protocol fixture, not an authenticated model.

For the complete native installed-project journey on Linux/macOS, after a build:

```sh
node scripts/release/project-worker-smoke.mjs --native
```

Set `WERK_PROJECT_WORKER_APP` to an extracted release's `bin/apps/worker` to qualify
the package. This uses a labelled CLI protocol fixture, project-local setup,
revision-guarded feature commands, chat/patch execution, durable before/after
evidence, run analysis and restart. No npm step runs in the test project. The
fixture executable is POSIX-only; it does not qualify Windows provider execution.

With Docker available, run the explicit installed-project journey after a build:

```sh
node scripts/release/project-worker-smoke.mjs
```

Set `WERK_PROJECT_WORKER_APP` to an extracted release's `bin/apps/worker` to test
the downloaded payload. The script runs setup inside a Node container (no host
Node used by the installation commands), starts generated Compose, ingests a
bind-mounted Markdown request, checks its exported result and restarts to verify
identity/no duplicate execution. It removes its own Compose services and scratch
project. It uses a provider protocol fixture and does not qualify live inference.

## Generated UI stories and release evidence

`npm run storybook:ci` builds actual Vue stories, captures desktop/mobile evidence and checks every first-party Vue source component against observed mounts. It requires Chromium and uses isolated synthetic fixtures without live model calls. `tests/storybook` exercises inventory and evidence validation; `tests/operations` checks artifact freshness, file integrity and publication gates. Follow the [storybook generation guide](../docs/how-to/generate-storybook.md) to add states or reproduce release screenshots.

## Architecture checks

After a coordinated build, run `node --test "tests/architecture/*.test.mjs"`.
The dependency utility scans TS/JS/CommonJS and both Vue script blocks. Negative
fixtures exercise actual boundary failures through imports, reexports, type edges,
require/createRequire, literal dynamic imports, absolute paths and package aliases.
Worker application and extracted orchestrator application modules cannot import
adapters, including for types. Selected shared contracts form a closed graph.
Computed imports are forbidden in those protected modules; composition remains
free to select configured adapters. This is a static guard, not arbitrary
JavaScript evaluation or automatic third-party package analysis.

Build-provenance tests compare the root manifest with every generated/portable
app, real MCP initialization responses and newly captured snapshot versions.
Rebuild after a root version change before running those artifact checks.
