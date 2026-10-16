# Changelog

Notable changes to Werk are recorded here using the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories.
Versioned entries use the release date in Europe/Berlin. This log starts with
0.8.0; earlier release notes remain in [GitHub releases](https://github.com/Luis85/production-line/releases).

## [Unreleased]

## [0.9.0] - 2026-10-16

### Added

- Stable instruction profile references. A worker operator assigns a reference such as `project-reviewer` to an imported agent definition, at import or with the new `definition ref` command, and requests select it with `definitionRef` instead of a worker-specific `definitionId`. Committed team templates and shared Git requests no longer need editing when the worker host changes.
- The webview definition editor accepts and shows a shared reference.

### Changed

- Shared Git intake no longer claims a request whose instruction profile the worker cannot resolve. The request stays ready and unclaimed, with the reason shown, so another worker or a later sync can take it.

## [0.8.0] - 2026-10-16

### Added

- Project `.env` and credential-free `.env.example` configuration for portable Factory, orchestrator and worker apps, including `env init` and worker token configuration.
- A required, versioned changelog check for release builds. Published release notes now use the reviewed entry shipped with the release candidate.

### Changed

- Worker application services now use injected persistence, filesystem and provider interfaces, with shared contracts for worker interactions and webview transport.
- Shared HTTP response handling, provider probes and Git launch policies replace duplicated implementations while preserving independent prebuilt apps.
- Runtime snapshots and MCP initialization report the packaged release version.
- Worker settings, task interactions and request views use focused components and shared presentation helpers.

### Fixed

- Inactive views stop polling, stale responses cannot replace newer data, and optional read failures no longer prevent independent panels from refreshing.
- Failed startup and shutdown attempt all owned resource cleanup, retain the original error and release worker locks. HTTP handlers finish or cancel before their databases close.
- Worker journal initialization closes partially opened SQLite databases and applies consistent private file and durability settings.
- Windows Git commands resolve the configured executable without implicitly running a repository-local `git.exe`.
- Source Docker builds include the build metadata helper required by all three apps.
