# Changelog

Notable changes to Werk are recorded here using the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories.
Versioned entries use the release date in Europe/Berlin. This log starts with
0.8.0; earlier release notes remain in [GitHub releases](https://github.com/Luis85/production-line/releases).

## [Unreleased]

## [0.9.1] - 2026-10-16

### Added

- Portable client option `--request-timeout-ms` (1,000–600,000) overrides how long a command waits for the API.
- `feature setup` and its plan warn with `authoring_script_outdated` when the committed `.werk/authoring/feature-request.mjs` differs from the bundled script. The guide explains how to compare and refresh it after an upgrade.
- `state_write_error` service events name the failing writer in `site` and include an allowlisted system error code such as `EPERM` or `EBUSY`.

### Changed

- `shared sync`, `shared configure` and `repository sync` wait up to 120 s instead of 10 s. A client timeout now reports `"code":"timeout"` and says the operation may still be running.
- `shared configure` names missing configuration fields instead of asking for an assigned repository.

### Fixed

- Portable CLI JSON input from `--file PATH` or `--file -` accepts a leading UTF-8 byte order mark, as written by Windows PowerShell 5.1 pipes.
- Shared-intake, provider-account, Taskboard page and webview asset requests no longer log as route `unmatched`. Runtime log capture keeps every normalized worker route.

## [0.9.0] - 2026-10-16

### Added

- Portable Factory, orchestrator and worker apps support `update check|apply|status|rollback|restore`. Updates verify release checksums, preserve a state backup and the previous app folder, and can gracefully stop and restart the selected instance.
- Portable instances record their launch directory and options for restart after an update.
- Worker consumption limits in the Dashboard and portable CLI: configure a daily or monthly token allowance and a worker percentage, such as a 50/50 split. Durable reservations and usage tracking cover chat, file tasks, request reviews and native Codex assignments.
- Stable instruction profile references. Assign a reference such as `project-reviewer` at import or with `definition ref`, then select it with `definitionRef` in team templates and requests. Existing tasks retain their accepted profile snapshot.
- The webview definition editor accepts and shows a shared reference.
- `shared status`, `shared sync` and `shared configure` worker commands for managing shared Git intake without the webview.

### Changed

- Stopped-state backup and verification are shared by native maintenance and portable updates.
- Release installation runs `tar` without opening a console window on Windows.
- Workers retain queued work while consumption blocks new starts and automatically resume eligible work after the UTC budget reset. Unknown usage blocks further model calls; an active call can exceed its reservation before reporting final usage. The allowance measures worker tokens, not a provider subscription balance or personal usage.
- Shared Git intake leaves requests ready and unclaimed when the selected instruction profile, agent or provider family cannot be used by this worker.

### Fixed

- Portable updates preserve the selected state directory and effective launch options, protect the restarted worker's lock during recovery, and restore the previous app if rollback-history publication fails.
- Local folder intake leaves shared-template notes untouched, including malformed markers and requests retained by an older worker. Existing local history remains inspectable, with recovery guidance and protected submit/retry actions.
- Windows publication path limits are checked before shared intake claims work, with accurate character and UTF-8 byte diagnostics and a usable shorter-state-directory example.
- Idempotent task replay rejects conflicting profile selectors while preserving its original immutable instruction snapshot.
- Fleet shutdown test fixtures install signal handlers before announcing readiness, eliminating the intermittent drain-order race.

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
