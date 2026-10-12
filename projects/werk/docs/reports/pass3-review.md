# Werk pass 3 review

This pass connects committed requirement context to opt-in task intake and worker evidence, bounds UI/MCP collection consumption, hardens stdio, and groups source and tests by concern. Execution remains mock-only. The [acceptance](pass3-acceptance.md) and [CLI findings](pass3-cli-report.md) record scope and the report-before-upstream-dispatch sequence.

## Product changes

- Operator configuration binds one local repository, exact commit and vault root. Ready requirement intake derives title/criteria and stores an immutable manifest before assignment. Schema 4 migrates existing mock databases without changing old task evidence. Idempotent retries preserve the original task and manifest even after binding changes or source removal.
- Workers verify manifest identity, file hashes and declared context policy before mock execution. Snapshots contain only the bound digest and provenance, never source text. Wrong assignments, lost leases and corrupt manifests fail closed. Durable terminal replay does not refetch context or rerun execution.
- Context resolution limits raw file bytes and serialized manifest bytes separately. Admission permits two concurrent resolutions with an eight-second outward deadline; cancellation cannot submit a late result after shutdown. Explicit-null dependency lists are rejected, and derived titles/criteria are trimmed consistently while committed content stays byte-exact.
- Task, worker and event pages load 50 records with explicit navigation, page-local filtering, retry and independent selected-task details. MCP inventory tools default to 100-item pages and reject malformed continuation responses. Stdio uses bounded frame assembly, honors output backpressure and stops after output failure without retrying tool calls.
- Minimal MCP/CLI requirement intake remains minimal on the wire, allowing the server to derive context. Client-authored context and metadata overrides cannot establish trusted source identity.

## Source and tests by concern

Factory groups application policies/ports and infrastructure adapters. Orchestrator groups context, persistence and intake modules while retaining composition roots and transaction boundaries. Worker groups application orchestration, HTTP/context adapters, durable journal infrastructure and status rendering. Shared contracts stay independent, with HTTP and MCP adapters in their existing concern folders.

All existing test files move into concern folders; test discovery uses quoted recursive Node 24 globs for both JavaScript module formats. The [architecture map](../explanation/architecture.md#implemented-dependency-map) and [test guide](../../tests/README.md) document placement. Public CLI, package, container and browser asset paths stay stable. Forge's new files already fit its existing document-command and project/document test folders; independent review found no useful extra moves.

## Verification

Independent reviewers examined context bounds, identity, idempotency, authorization, snapshot provenance, shutdown and source privacy. A real CLI-process test passed intake, restart with a newer binding, complete source-directory removal, idempotent retry, mock execution and matching before/after hashes. Desktop/mobile browser fixtures passed pagination, retry, session clearing and layout checks; evidence is in [pagination UI](../explanation/pagination-ui.md).

The initial full run found one boundary-inventory omission for the new pure shared context contract. The contract was added to that explicit inventory; transitive dependency checks remain enforced and pass. Final workspace `npm run check` passed: TypeScript, all three independent builds, and **272 tests with zero failures, skips or cancellations**. An independent isolated structure check passed the same 272 tests. All 42 original test files remain included, with their test registrations preserved. Dependency audit reports zero vulnerabilities. Forge strict vault validation, backlog consistency and workflow synchronization passed; the vault has no errors or warnings, with three informational Dockerfile attachment findings from the installed CLI. Six pass-3 improvements are Done; the backlog totals 18 Done, 13 Open and one Active. The original uploaded zip retains SHA-256 `6de314df94082e24a1a53c61b804de82c7fa3209f27d7da5d1e555b31f71080c`.

## Remaining readiness gaps

This remains a tested mock foundation. It has no live Claude/Codex adapter, provider isolation/quota policy, fenced Git publisher, verified PR checks/review/merge workflow, or production deployment acceptance. P0-01 remains Active: repository identity is a canonical local path, resolution follows only explicit whole-Markdown dependencies, and iteration imports are not yet integrated with verified bound intake. Bound intake accepts at most 30 criteria; the standalone resolver preview permits up to 100. Full manifests are capped at 4 MiB serialized JSON; source bytes remain capped at 2 MiB. Legacy unpaged HTTP endpoints remain available, although UI and MCP now request pages. Large MCP output fails explicitly at its existing 1 MiB cap and callers must reduce their limit.

Werk changes remain local in the project. Upstream Forge work is a separate main-based PR; prior PRs are not merged or represented as installed.

## Upstream Forge result

[PR #25](https://github.com/Luis85/agent-cli/pull/25) delivers bounded batch reads and explicit read/apply project targeting, with documentation, skills, schemas, tests and regenerated distribution/showcase. Its final full gate passed 2,762 tests with two skipped and no showcase drift. It is open for review; GitHub CI was running/queued at the first check. Prior PRs #23/#24 remain separate. The [CLI report](pass3-cli-report.md) records initial friction, corrections, useful future tools and exact commit identity.
