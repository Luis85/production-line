# Changelog

Notable changes to Werk are recorded here using the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories.
Versioned entries use the release date in Europe/Berlin. This log starts with
0.8.0; earlier release notes remain in [GitHub releases](https://github.com/Luis85/production-line/releases).

## [Unreleased]

## [0.9.0] - 2026-10-16

### Added

- Portable Factory, orchestrator and worker apps update themselves with `update check|apply|status|rollback|restore`. `apply` verifies the release against its `SHA256SUMS` (or an extracted release with `--from`), refuses a running instance unless `--stop` is given, takes a verified state backup, replaces the app folder by renames that keep the previous folder, and restarts only an instance it stopped.
- Portable instances record their launch directory and options so an update can restart them unchanged.

### Changed

- Stopped-state backup and verification are shared by native maintenance and portable updates.
- Release installation runs `tar` without opening a console window on Windows.

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
