# Changelog

Notable changes to Werk are recorded here using the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories.
Versioned entries use the release date in Europe/Berlin. This log starts with
0.8.0; earlier release notes remain in [GitHub releases](https://github.com/Luis85/production-line/releases).

## [Unreleased]

## [0.10.0] - 2026-10-17

### Added

- `definition update --ref REF --file PATH` replaces the instruction profile behind a stable reference in place, keeping its id and reference. `--dry-run` previews the name, digest and per-agent changes without writing; applying requires `--if-match` with the current definition `revision`, now listed by `definition list`. Existing tasks keep their accepted profile snapshot.
- An "Operate a project worker" how-to with a day-to-day checklist and Windows PowerShell 5.1 guidance: BOM-free JSON input files, why piping to `--file -` loses non-ASCII text, task worktree location and manual cleanup, tool limits and the chat workspace, and the answer protocol. It ships in the release documentation.
- Portable client option `--request-timeout-ms` (1,000–600,000) overrides how long a command waits for the API.
- `feature setup` keeps the committed `.werk/authoring/feature-request.mjs` current after upgrades.
  - Setup records the installed script's content hash in `.werk/authoring/manifest.json` and replaces the script while it still matches that record.
  - A customized or unrecorded script is preserved, and setup reports `authoring_script_outdated` with its `revision`.
  - `feature setup --if-match REVISION` replaces exactly that revision.
- `state_write_error` service events name the failing writer in `site` and include an allowlisted system error code such as `EPERM` or `EBUSY`.
- New repository requests can implement features in their isolated worktree: explicitly approved file edits, required verification commands, repair loops and review patches generated from the actual candidate. Check receipts are tied to the candidate and appear in the webview and Markdown records; legacy requests retain proposal behavior.
- Configurable tool-call and command-duration budgets accompany the task duration, including API loops and the CLI MCP bridge. Optional per-command, CLI-tool and MCP deadlines are managed in **Settings → Tools & MCP**; a shared resolver enforces them within the accepted attempt budget and records effective limits in the model dispatch.
- Project CLI tool grants let the model pass arguments to an approved executable in its task worktree, within allowed commands, required flags, refused options and argument/output limits. Tools start disabled and run without a shell. Configure them in **Settings → Tools & MCP** or with `tool-access get|set`; `tool-access discover` reads saved MCP tool catalogs without granting access.
- Every worker task has a Markdown feature-request record with its instructions, progress, questions and results. Follow-ups update the same record, with saved state and recoverable synchronization errors visible in the webview.
- A dedicated worker Settings page with focused navigation for providers and accounts, queue capacity, task duration, consumption, tool and MCP access, repositories, shared intake, execution profiles, agent definitions, project integration and optional orchestrator enrollment.
- A shared capacity readout on the taskboard: one execution slot, actual accepted chat/file work and available places, separate remote assignments, and explicit pause or consumption blockers.

### Changed

- File-task review patches contain minimal Git hunks with three context lines instead of replacing every line of a changed file. Quoted paths, missing final newlines and `git apply` compatibility are preserved.
- The file-task prompt states the exact patch reply limits. A single patch object surrounded by prose or a Markdown fence is accepted; two different objects are refused as ambiguous.
- Worker architecture shares candidate receipt classification, guarded settings state, sensitive-patch and MCP endpoint policies, and contained tool launch mechanics. Explicit public task DTOs and allowlist projections keep private execution data behind the application boundary.
- `shared sync`, `shared configure` and `repository sync` wait up to 120 s instead of 10 s. A client timeout now reports `"code":"timeout"` and says the operation may still be running.
- `shared configure` names missing configuration fields instead of asking for an assigned repository.
- Worker navigation now separates Taskboard, Metrics, History and Settings. Existing dashboard setup bookmarks continue to open the corresponding settings section.
- One request composer handles instructions and optional approved repository files. Provider, model, tool and agent options disclose when needed; retries retain the original request identity. Task and conversation navigation remains accessible on narrow screens.
- Metrics prioritizes consumption and retained execution measurements, with coverage and scope labels, followed by worker health and host resources.

### Fixed

- Approved file paths accept real-world vault names. Names may use Unicode letters and marks, such as umlauts and `ß`, plus spaces and `, ( ) & ' ’ + – — →`. This applies to file tasks, local and shared feature requests, offline authoring and live Codex `allowedPaths`. Paths are compared and stored in NFC form, so a decomposed duplicate is rejected. A project's committed `.werk/authoring/feature-request.mjs` keeps the old rule until the script is refreshed.
- The rule now also rejects Windows-reserved characters, device names such as `nul.md`, and segments that end in a dot or space. It also rejects segments over 255 UTF-8 bytes and look-alike secret names.
- A file task refuses a path whose on-disk name differs only by Unicode normalization. Shared publication refuses a new file that differs from a tracked file only by case or normalization. Neither creates a second file that looks identical.
- A file task whose model reply breaks the patch format now records the specific rule, such as `The summary has 2001 characters; the limit is 2000.`, in the task error, and a matching `patch_*` code on the interaction turn and its `failed` event, instead of the generic "Task could not produce a valid patch".
- Tool deadline edits retain existing overrides when older clients omit them, support an explicit reset to inheritance, and preserve queued dispatch compatibility. Codex and Claude CLI bridges receive the accepted execution deadline.
- Completed proposal transcripts show the model summary and changed-file line counts, with a link to the retained patch. Legacy protocol replies render readably when task evidence identifies them; ordinary JSON examples remain code. Paths and globs stay literal, and stored raw replies remain available for inspection and continuation.
- API provider responses support bounded gzip, deflate and Brotli decoding with consistent protocol errors, cancellation and connection cleanup. CLI request timeouts respect the configured deadline across the native Node and packaged HTTP adapters.
- Managed authoring-script refresh cleans up after write/fsync failures, preserves ordinary file permissions and applies the same manifest size limit during planning and execution.
- On Windows, contained processes (command presets, MCP servers and provider CLIs) no longer receive PowerShell progress records (`#< CLIXML … <Objs …>`) from the job supervisor in their stderr. These appeared when the worker passes a minimal environment, because Windows PowerShell then prepares its modules on every launch.
- Portable CLI JSON input from `--file PATH` or `--file -` accepts a leading UTF-8 byte order mark, as written by Windows PowerShell 5.1 pipes.
- Shared-intake, provider-account, Taskboard page and webview asset requests no longer log as route `unmatched`. Runtime log capture keeps every normalized worker route.
- CLI grants reject response-file and extracted-path escapes and ambiguous required flags; CLI-only grants revalidate retained Git worktree ownership. Exported MCP catalogs can round-trip through the tool-access CLI while preserving API size limits and secret handling.
- Portable startup resolves valid state-directory parent aliases before saving request Markdown, including macOS path aliases. Symlinked state directories and managed note directories remain refused.
- Interrupted repository preparation can recover through the same request identity when its retained worktree is unchanged. Edited worktrees are preserved with a failed request and explicit recovery guidance.
- Open request notes retain their rendered contents across unchanged background snapshots.
- Background polling no longer repeatedly replaces button labels or icons with loading indicators, shifts their width, or temporarily disables valid actions. Deliberate refreshes and saves retain visible feedback.
- The taskboard no longer reports availability while consumption blocks new starts, or treats executor waiters as the complete worker queue.
- Queue and duration settings detect competing edits, retain unsaved drafts and protect the queue's independent pause state.
- Task freshness updates independently of optional history reads. Stale capacity stays explicitly labelled, and late settings responses cannot replace newer acknowledged configuration.
- Worker resource descriptions distinguish whole-machine measurements from the Node process, and small-screen controls retain clear labels and keyboard access.

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
