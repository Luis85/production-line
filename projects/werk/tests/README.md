# Test suites

Run `npm test` from the project root with Node 24. The command builds all three applications, then Node expands quoted recursive globs for every `*.test.mjs` and `*.test.cjs` under this directory. `npm run check` also runs TypeScript checking. There is no separate JavaScript test framework or shell-specific recursive glob setting. On Linux/macOS, the infrastructure suite also runs Python 3 archive/readiness regressions through a Node wrapper; install Python 3 for the complete source check. Linux systemd unit validation runs when systemd-analyze is available. These are maintainer checks, not extra requirements for the native downloaded runtime.

| Directory | Concern |
| --- | --- |
| `architecture/` | Shared dependency boundaries and domain/adapter separation |
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
