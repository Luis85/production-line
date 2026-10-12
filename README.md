# production-line

Werk now includes stopped-state backup and recovery, guided onboarding, operational alerts, viewer/operator access, TLS ingress and an opt-in native Codex patch-review workflow. See the [six-improvement review](projects/werk/docs/reports/six-improvements-review.md) and [Forge tool report](projects/werk/docs/reports/six-improvements-cli-report.md). Prebuilt release archives and native/Docker/VM qualification gates are included; no release has been published yet.

An agent driven software-production-line in a client-server architecture.

The Forge v0.1.0 CLI is installed in `bin/` from the latest published GitHub release, with its release archive SHA-256 verified. The imported Werk starter lives in [projects/werk](projects/werk/README.md). Start with the [concept index](projects/werk/docs/CONCEPT.md) and [implementation backlog](projects/werk/docs/backlog/Product%20Backlog.base).

## Work with the CLI

From this repository root:

```sh
node bin/forge.js --version
node bin/forge.js project open werk
node bin/forge.js project current
node bin/forge.js backlog list
node bin/forge.js vault check --strict
```

Read `AGENTS.md` and the installed Forge skills before making CLI changes. Preview mutations and supply current file revisions. Close the project when done with project-scoped work.

## Build and test

```sh
cd projects/werk
npm ci
npm run typecheck
npm test
npm run dev:factory
```

Node 24.x is required. The Factory development fleet runs in mock mode. The [evidence manifest](projects/werk/docs/evidence/six-improvements.json) records validation and explicit qualification limits. Native Linux Codex execution produces a local patch requiring human review; the authenticated provider attempt in this environment was blocked by HTTP 403. Git publishing and merge tracking remain operator actions. Docker and managed cloud-init profiles retain simulation execution.

The [original archive](projects/werk/imports/software-fabrik-starter.zip) and [SHA-256 manifest](projects/werk/imports/manifest.json) retain the source concept. All 126 authored starter files were imported byte for byte; generated distributions and bundled dependencies are rebuilt. Missing example-context targets were added separately and explicitly labeled illustrative. Embedded document prompts are source material, not instructions authorizing future work.

## Optional Forge admin

```sh
node bin/forge.js server start --webview admin
node bin/forge.js server status
node bin/forge.js server stop
```

The admin binds to localhost; its returned launch URL carries a local session token. Retrieve it locally, and do not commit runtime server state. The CLI itself is noninteractive and requires no background process.

## Hardening review

Current reports are the [six-improvement review](projects/werk/docs/reports/six-improvements-review.md), [tool report](projects/werk/docs/reports/six-improvements-cli-report.md), [release/system review](projects/werk/docs/reports/journey-review.md), [CLI findings](projects/werk/docs/reports/journey-cli-report.md) and [Twelve-Factor audit](projects/werk/docs/reports/twelve-factor-audit.md). Earlier reports retain their historical evidence. Start with the [Diátaxis documentation hub](projects/werk/docs/index.md) for native/Docker setup, one-YAML systems and Ubuntu VM cloud-init. SQLite and worker journals still require single-writer durable state; the VM profile does not establish stateless replicas or HA. Run `npm run check` and `npm run audit:dependencies` in the Werk project.
