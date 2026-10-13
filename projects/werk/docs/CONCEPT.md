# Werk concept and imported starter

Werk is an agent driven software production line with independently deployable Factory, line orchestrator and worker applications. The imported starter is an executable mock foundation; live provider execution, Git publication, review/rework and merge tracking remain planned work.

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
live factory from the implemented mock runtime.

## Local development

From projects/werk, use Node 24.x and run npm ci, npm run typecheck, and npm test. Run npm run dev:factory for the local mock fleet. The workspace CLI is ../../bin/forge.js when invoked from this directory; use --root ../.. before its command, or run it from the workspace root.
