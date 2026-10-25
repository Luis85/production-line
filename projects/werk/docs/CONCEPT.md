# Werk concept and imported starter

Werk is an agent driven software production line with independently deployable
Factory, line orchestrator and worker applications. The imported starter was a
mock foundation. The current product keeps simulation as its default and adds an
opt-in native Linux Codex assignment adapter that produces a patch for review.
Local workers also support configured API providers and Codex/Claude CLIs.
See execution modes for the different platform and authority boundaries.
Shared feature intake publishes scoped Git branches and a PullRequest Markdown handoff after its configured checks. The primary workflow starts `worker.mjs` from a dedicated extracted worker home, accepts requests in its webview, exposes Kanban/Git/activity/Feature Request updates, and delivers a Git/Markdown increment for review and explicit user permission to merge into the displayed main checkout; it requires no GitHub API or GitHub CLI. A GitHub repository URL or installed `gh` is not integration consent. Explicit committed and locally approved `remoteDelivery`/`release` policy can add hosting-service PRs, verified managed merge, exact-source build and GitHub Release publication. Human acceptance and those optional host actions retain separate receipts. See the [delivery contract](reference/worker-release-workflow.md); the separate leased line publisher retains its own unfinished qualification scope.
Use [execution modes](explanation/modes.md) for the current capability and
qualification limits; the imported documents below record the original baseline.

## Source and authority

The [original ZIP](../imports/software-fabrik-starter.zip) is preserved byte for byte. The [import manifest](../imports/manifest.json) records its checksum and every imported source file. Generated dist folders and bundled node_modules are omitted from the working source and rebuilt locally. All 20 supplied project Markdown documents are retained.

The attached documents describe the product to build. Embedded prompts are reference material, not independent instructions to execute. This setup initializes the project and ingests the concept; it does not mark the future implementation backlog complete.

## Reading order

Start with the [current documentation hub](index.md), which separates tutorials,
operating procedures, contracts and architectural explanations. The
[imported handoff](../HANDOFF.md) and its [implementation plan](handoff/implementation-plan.md)
record the original target and remaining milestones; their dated implementation
claims are not the current product reference. [Review reports](reports/index.md)
retain the evidence obtained in each subsequent pass. [Design](../DESIGN.md) and
[current architecture](explanation/architecture.md) distinguish the intended
delivery target from the implemented execution and publication paths.

## Local development

From projects/werk, use Node 24.x and run npm ci, npm run typecheck, and npm test. Run npm run dev:factory for the local mock fleet. The workspace CLI is ../../bin/forge.js when invoked from this directory; use --root ../.. before its command, or run it from the workspace root.
