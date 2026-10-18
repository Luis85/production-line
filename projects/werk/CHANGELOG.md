# Changelog

Notable changes to Werk are recorded here using the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories.
Versioned entries use the release date in Europe/Berlin. This log starts with
0.8.0; earlier release notes remain in [GitHub releases](https://github.com/Luis85/production-line/releases).

## [Unreleased]

### Added

- Shared Feature Requests support optional `readyPrompt` and `donePrompt` paths in `.werk/feature-workflow.json`. Teams commit Markdown or text definitions of ready and done; the worker pins their content and digests before claim and supplies them on dispatch and continuation. The shared-workflow view exposes their paths and digests. These prompts supplement deterministic readiness/completion checks and retain existing tool, edit-scope and human-review boundaries.
- An optional `readyReviewPrompt` enables a model Feature Request Ready Check before deterministic readiness checks. The worker confirms its Git claim, reviews using the request's selected model and existing capacity/allowance (tool-free Codex/Claude/API or Cursor's native read-only ask mode), and publishes findings in the same request. Questions pause work until the team answers in Markdown and commits and pushes `status: ready`; unchanged polling never starts another review.
- Feature Requests can select provider, model and supported reasoning effort in Markdown and the webview. Editable worker defaults apply to new requests; accepted provider/model/effort selections remain fixed through Ready Check answers, implementation and restart recovery.
- Cursor CLI integrates account login or a private Cursor API key, exact native session continuation and candidate implementation under Cursor's native permissions, hooks and subagent policy. Supplemental Werk grants retain their own boundaries; required worker checks still gate review. Token and cost usage remain unavailable, including native subagents, and do not bypass consumption holds.
- An optional `readyReviewPrompt` enables a model Feature Request Ready Check before deterministic readiness checks. The worker confirms its Git claim, reviews without tools using the request's selected model and existing capacity/allowance, and publishes findings in the same request. Questions pause work until the team answers in Markdown and commits and pushes `status: ready`; unchanged polling never starts another review.
- `init` and `feature setup` accept `--workflow-dir DIR` to place the Feature Requests Base, `reviews`, `tasks` and the ready/done check files under one project folder, such as a structured Obsidian vault, instead of the project root. The Base's folder filters follow. An existing `.werk/feature-workflow.json` still wins; a differing `--workflow-dir` is reported as a warning naming both locations and nothing is moved.
- `init --no-npm` skips creating the root `package.json` and reports `npm: { skipped: true }`.
- `definition import --ref REF` sets the stable reference in the same operation; a reference another definition holds is refused with the existing conflict message.
- `definition preview`, `import` and `update` responses include a top-level `warnings` array naming each agent that requires adaptation and its unsupported items.
- `update apply --in-place` and `update rollback --in-place` update a portable app folder that another process holds open, which blocks the folder rename on Windows. The option is explicit, never automatic. Release verification, `--stop`, the state lock, state backup and history are unchanged; instead of renaming, the updater keeps a verified copy in `bin/apps/.<app>-update/`, writes changed and added files, deletes files outside the release manifest, reports directories it had to leave empty and verifies the folder against the manifest byte for byte. On any failure it restores the copy in place, verifies it and restarts the previous version. When a normal update fails because the folder is held open, the error now suggests `update apply --stop --in-place`.

### Changed

- Advisory mutation testing now covers the Ready Check protocol, shared review lifecycle and review eligibility alongside the existing accounting and boundary checks. Expanded failure, recovery and concurrency contracts improve the baseline; exact compiled-source, suite and configuration provenance prevents comparing incomplete or stale measurements. Mutation findings continue to warn without blocking releases or running in ordinary development checks.
- The portable CLI and shared HTTP client wait 30 s by default instead of 10 s for each API call, including each `feature wait` poll and `interaction answer`, which exceeded 10 s on a busy Windows operator host while the operation still succeeded server-side. Git operations and `settings set` keep 120 s; `--request-timeout-ms 1000–600000` still overrides the wait. The `requestTimeout` help text and the runtime CLI reference state the new values.

### Fixed

- `env init` and `init` append only the `.env` and `!.env.example` ignore rules that `.gitignore` does not already contain as exact lines, write nothing when both exist, never repeat the comment header and report the added lines as `ignoreAdded`.
- A profile that needs adaptation no longer leaves a request waiting with a generic error. The message names the agent, its unsupported items (an unsupported schema version shows its value and the supported range 0–16) and both remedies: fix the profile and run `definition update`, or set `useInstructionsOnly: true`. `feature validate` and local folder intake now report this, and an unknown `definitionRef`, before the request is reserved; task creation keeps the check as a safety net.
- Tool Access validation errors for a command preset, CLI tool or MCP connection now name the entry and the field and give the reason, for example `Command preset "git-log": Command executable contains control characters.`, instead of `Use a valid Command executable.` Reasons are `is empty`, `is longer than N characters`, `contains control characters`, `is not text` or `must be empty here`; list items are numbered, and an entry without a usable ID is named by position. Accepted inputs are unchanged.
- `settings set` waits up to 120 s, like the Git-backed commands, because assigning repositories and changing worktree folders validate checkouts and exceeded 10 s on a large vault.
- Contained tool processes on Windows keep the worker's `PATHEXT` and `ComSpec`. Windows PowerShell, which runs the job supervisor, appended `;.CPL` to a missing `PATHEXT`, so the child saw `PathEXT=.CPL` and its `cmd.exe` could not resolve `node`: npm lifecycle scripts such as `node -e …` failed only under containment, which broke required checks running `npm ci` or `npm run`. The supervisor now restores the caller's exact `PATHEXT` (or removes it) before creating the child, and approved command presets and CLI tools pass `PATHEXT` and `ComSpec` through when present.

## [0.13.0] - 2026-10-18

### Added

- Verified implementation source bounds are configurable in **Settings → Queue & duration → Repository inspection limits** and through the settings API/CLI: 64 MiB total source, 20,000 paths and 8 MiB per file outside the approved edit list by default. Guarded saves detect concurrent changes; each prepared implementation dispatch freezes the bounds and records them with tool-limit evidence. Larger repositories still receive complete inspection without widening approved edit scope.
- A dedicated Feature Request review page brings accepted scope, navigable diffs, current verification, human acceptance and shared handoff together with an explicit next action.
- Explicit service presets let requests run bounded development services in their owned worktree. The worker supervises lifetime, readiness, restarts, logs and cleanup; Metrics exposes service controls and separately scoped finite-process observations.
- Generated README documentation uses maintained content and qualified Storybook screenshots. Release verification produces a versioned README bundle with screenshot provenance and checksums, while drift checks keep source text in sync.
- Durable model sessions belong to each Feature Request, with explicit Claude CLI continuation, worker-managed replay for Codex/API adapters, bounded active context and private history retrieval. An optional committed project-context manifest shares reviewed knowledge without mixing conversations.
- Tool Access can grant bounded model subagents. Children retain the parent request, provider/profile, approved tools and execution budget, with separate consumption and linked run evidence.
- An overnight team guide explains evening Git handoff, unattended implementation, Markdown answers and morning human review.

### Changed

- The README follows the setup journey from a project worker through Orchestrator enrollment to Factory line registration, with a hierarchy diagram and current execution-mode boundaries.
- Claude Code readiness now requires version 2.1.257 or later for explicit session continuation with refreshed instructions.
- Worker Metrics visualizes current execution/admission capacity, configured token allowance, process/host resources and retained attempt outcomes. Execution summaries offer acceptance-time windows with measured duration and token/cost coverage, while settings and detailed evidence remain linked to their own pages.
- Allowance and resource displays distinguish reported usage, reservations, unverified balances, worker-process measurements and host/volume context. Runtime diagnostics and alert history disclose beneath the overview.

### Fixed

- Process metrics scans stop when their owned process exits and use a bounded read budget. Cancelled or incomplete scans report unavailable counters, so background observation cannot prolong worker shutdown by scanning the remaining process table.
- Shared Feature Requests only report synchronized publication when the current lifecycle and review note are confirmed. Recovery retries unfinished handoff publication without repeating completed model work.
- Unresponsive development-service hosts cannot hold startup or shutdown operations indefinitely. Unconfirmed cleanup retains its occupied slot, reports an actionable state and blocks overlapping replacements.
- Review links preserve the exact request through section navigation; inconsistent ownership and stale checks cannot be presented as current approval evidence. Background refresh preserves controls and readable Markdown summaries.
- Shared intake observes actual worker admission capacity before claiming ready requests. Temporary holds and preparation failures publish accurate informational Task notes and retain safe retry/publication behavior.
- Restart recovery preserves a prepared queued dispatch only when all retained authorities prove it never started; running, contradictory or incomplete attempts remain fenced for explicit recovery.
- Metrics reads track freshness independently, retain stale values on failed refreshes and keep background updates from animating action buttons. Query changes, locking and page lifecycle changes reject obsolete responses; displayed age continues to advance while browser updates are paused.
- Verified implementation inspection no longer fails with a generic Git error when the tracked file list is large: the Git output bound for the candidate file listings now scales with `execution.candidateSourceMaxFiles` (about 4 KiB per file, at least 2 MiB). A listing above that bound reports its size limit and names the setting to raise.
- `feature wait`, `task wait` and `file-task wait` retry client status-read timeouts and transient connection failures within their `--timeout-ms` deadline. Each poll is bounded by the remaining wait, with no extra poll after expiry; API and input errors still end the wait immediately. Timeout diagnostics report failed polls and explain that no cancellation was sent, without claiming the task is still running when its current state is unknown.

## [0.12.0] - 2026-10-18

### Added

- Teams can answer worker questions and resume stopped attempts through guarded Task Markdown notes. Shared Git intake consumes committed and pushed replies, acknowledges them without replaying execution, and links progress and PullRequest review notes from the original feature request.
- Configurable public Task folders and actionable intake diagnostics make readiness and configuration blockers visible without opening the webview. Obsidian Bases include requests, human Tasks and review notes.
- The portable worker provides `shared setup --file` with a read-only preview, explicit repository selection, local CLI provider checks and optional reviewed tool grants for headless team setup.
- `definition preview|import|update --file` accept `.yaml` and `.yml` profile files directly. A new `--name` option sets the profile name for import and update; importing a YAML file requires `--name`, and a `--name` that conflicts with a JSON `name` is refused.
- The `tool-access set` catalog example includes a command preset with `"verification": true`, so `schema` shows how to mark a required feature check.
- Shared-project webview chat prepares a Feature Request from the committed template, exposes editable request details and readiness findings, and saves drafts or publishes ready notes to Git. Connected CLI `feature prepare`/`feature publish` use the same guarded authoring API.

### Changed

- Project and repository READMEs guide installation, shared Markdown/chat requests and configuration with labelled system screenshots.

- `tool-access set` always drops the view-only fields of an edited `tool-access get` output (`revision`, `schemaVersion`, `canEdit`, `saveBlockedReason`, `workerNode`, and MCP `hasSecret` and `discoveredTools`) and refuses a `revision` that differs from `expectedRevision`. Tool-access and MCP connection validation errors name the unexpected fields (the first five); CLI tool entries keep their allowed-field message.
- The update error for a locked app folder now says that another process holds a file or directory open, lists likely causes (editors, indexers, antivirus scans, MCP or language servers started in the project folder) and states that nothing was replaced.
- The implementation-mode guide explains that a task worktree has no `node_modules` and must not link the checkout's dependencies, and that existing grants such as `git checkout`, `git clean` or `git stash` operate on the candidate. The portable-apps reference gains troubleshooting for the locked-folder update error.
- Feature Requests carry a stable parent identity across intake, sessions, execution/gate requests, Task answers and review notes. Generated tracking for source-backed requests is a `FeatureRequestProgress` projection, preventing a second intake entity. Existing executors and journals keep their owned state.
- Webview and Markdown requests share Git admission, claims and completion. Webview answers publish the same Task response for the existing consumer; shared-bound projects refuse legacy direct creation even while new claims are paused.

### Fixed

- Legacy requests retain their identity through restarts and feature-folder relocation, with historical review evidence preserved. Shared intake rejects cross-source identity collisions and keeps private Task companions out of shared Git publication.

- Project initialization explains the shared Git connection required by its generated feature template and seeds the chosen provider in new templates while preserving existing team customizations.
- An invalid `repositories.worktreeDirectory` reports `Task worktree directory must be absolute on the worker machine.` instead of the repository path message.

## [0.11.0] - 2026-10-17

### Added

- Source files are limited to 400 code lines and tests/helpers to 450, excluding blank and comment-only lines. Oversized services, frontend controllers and components are split by responsibility. Test typechecking covers maintained JavaScript, CommonJS and TypeScript fixtures against original source contracts.
- Pinned Oxlint and fallow-rs enforce correctness, dependency hygiene and architectural boundaries in `check:fast` and CI. Existing export findings have an explicit reviewed baseline; new findings and boundary violations fail the check.
- Stryker mutation testing with recorded shared-boundary and expanded worker-accounting/protocol baselines, opt-in local commands, JSON/HTML reports and an advisory release job. Survivors, regressions and incomplete measurements warn without blocking publication; ordinary development checks do not run mutation testing.
- A documentation-first Storybook with ordered setup paths for local workers, distributed teams, system operators and frontend contributors. Canonical guides, system journeys and source-derived component contracts remain together in the published documentation.

### Changed

- Worker persistence and admission queues share one FIFO operation helper with explicit failure isolation and drain semantics. Owners retain their transactions, cancellation and admission rules. Architecture checks now cover Factory application policy and the orchestrator application boundary.
- Factory, MCP, web tools and model providers share owned HTTP dispatcher mechanics while preserving their own authentication, deadlines, response limits and error contracts.
- All three webviews share JSON request construction, and worker settings panels share save/retry/recovery feedback with consistent accessible controls.

### Fixed

- Worker HTTP adapters reject malformed assignment data before application execution while preserving valid legacy assignments and extension fields.
- Public worker summaries explicitly project operational policy fields, keeping internal configuration hashes and future private fields out of status responses.
- Storybook qualification binds the documentation inputs as well as component source, preventing stale setup guidance from being packaged as current evidence.

## [0.10.0] - 2026-10-17

### Added

- File requests accept `"background": true`: the request returns immediately and the board lists the admission under `preparations` with its phase, or the specific reason it failed, until the task appears. The unified **New request** composer shows preparation progress while retaining the request draft and identity until its Markdown record is saved.
- Deleting a file task removes its Git worktree when it is clean and verifiably owned (identity pin, ownership marker, registration, base commit). `removeWorktree` and `discardChanges` options, also as `file-task delete --remove-worktree|--discard-changes`; changed worktrees are kept with a reason unless discarding is confirmed.
- `worktrees list` and `worktrees prune [--id] [--repository] [--discard-changes true] [--dry-run]` worker commands and `/api/worktrees` list and remove task worktrees that no file task uses, such as leftovers of interrupted admissions.
- Optional `repositories.worktreeDirectory` (**Settings → Repositories → Task worktree folder**) places new task worktrees outside the checkouts, so project tools do not scan them. Existing worktrees are still found at their recorded location.
- Opt-in chat working directory for command presets and stdio MCP connections. Chat has no task worktree, so these tools start in the worker's empty private chat workspace by default. Choose **Working directory in chat → Live checkout of repository** in **Settings → Tools & MCP** (`"chatDirectory": "repository:<id>"`) to start that grant's chat calls, and MCP discovery, in an assigned repository's live checkout. Saving and every call check the assignment; removing or moving the repository refuses the call before any process starts. Task invocations keep their pinned task worktree.
- `definition update --ref REF --file PATH` replaces the instruction profile behind a stable reference in place, keeping its id and reference. `--dry-run` previews the name, digest and per-agent changes without writing; applying requires `--if-match` with the current definition `revision`, now listed by `definition list`. Existing tasks keep their accepted profile snapshot.
- An "Operate a project worker" how-to with a day-to-day checklist and Windows PowerShell 5.1 guidance: BOM-free JSON input files, why piping to `--file -` loses non-ASCII text, worktree storage and safe cleanup, configurable tool limits, chat working directories and the answer protocol. It ships in the release documentation.
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

- Task worktrees use Git's parallel checkout with at most eight workers and a serial fallback for long Windows Git administration paths.
- Worktree admission has one total budget: 120 seconds for foreground requests or ten minutes for background preparation. Checkout may use up to five minutes within the remaining budget; ordinary Git metadata operations retain shorter deadlines.
- Admission verifies the new worktree for tool use without fetching the repository a second time.
- Worktree preparation failures report their reason (for example a Windows path limit) with HTTP 409/503 instead of a generic 500.
- Model tool results report when a quarter or less of the accepted call or time allowance remains, using the configured limits captured for that invocation. Defaults remain 128 calls and a six-hour invocation.
- In chat, tool descriptions, command results (`workingDirectory`) and failures of tools that start in the private chat workspace say that it has no project files and how an operator can choose a repository. Task tool descriptions and results are unchanged.
- File-task review patches contain minimal Git hunks with three context lines instead of replacing every line of a changed file. Quoted paths, missing final newlines and `git apply` compatibility are preserved.
- Proposal-task prompts state the exact patch reply limits. A single patch object surrounded by prose or a Markdown fence is accepted; two different objects are refused as ambiguous.
- Worker architecture shares candidate receipt classification, guarded settings state, sensitive-patch and MCP endpoint policies, and contained tool launch mechanics. Explicit public task DTOs and allowlist projections keep private execution data behind the application boundary.
- `shared sync`, `shared configure`, `repository sync`, `worktrees list` and `worktrees prune` wait up to 120 s instead of 10 s. A client timeout now reports `"code":"timeout"` and says the operation may still be running.
- `shared configure` names missing configuration fields instead of asking for an assigned repository.
- Worker navigation now separates Taskboard, Metrics, History and Settings. Existing dashboard setup bookmarks continue to open the corresponding settings section.
- One request composer handles instructions and optional approved repository files. Provider, model, tool and agent options disclose when needed; retries retain the original request identity. Task and conversation navigation remains accessible on narrow screens.
- Metrics prioritizes consumption and retained execution measurements, with coverage and scope labels, followed by worker health and host resources.

### Fixed

- Local lifecycle and health checks, plus private component requests, use the packaged HTTP transport with their existing deadlines. This avoids a Node 24/macOS socket error during stop or restart and closes each request’s connection resources.
- Profile update revisions bind the reviewed definition ID and reference as well as its name and content, preventing a stale preview from updating a different profile after reassignment.
- Chat tool grants pin the checkout’s filesystem identity and recheck it before each call. Changing an MCP chat directory invalidates its catalog and grants so discovery must be reviewed again.
- Worktree pruning excludes concurrent admission and configuration changes. Retained worktrees use their recorded location after storage changes, and new external storage is checked against every assigned repository.
- Fixture cleanup handles exited Linux zombie processes, bounds process inspection and termination, waits for its cleanup guard to exit, and preserves workspaces when process cleanup cannot finish.
- Shared feature publication no longer deletes files outside its temporary worktree on Windows. Git for Windows' `worktree remove` follows NTFS junctions, so cleanup now removes symbolic links and junctions themselves first. A worktree whose links cannot be removed is kept and locked in Git with a reason for manual review.
- Task worktree removal never runs Git on a worktree containing symbolic links or junctions: Git for Windows deletes the junction target's files, also in ignored folders and without `--force`.
- Test fixtures that start portable apps no longer leave detached workers running on Windows after a failed, timed-out or interrupted run. Cleanup stops each app and then terminates any process still running from the fixture's temporary directory. It waits for those processes to exit before removing the directory.
- Calls refused by the tool budget return a clear error telling the model to finish or ask the operator. API adapters bound the extra refusal and final-answer rounds; CLI bridges return the refusal instead of silently dropping the call. The overall invocation deadline and cancellation remain authoritative and can end the attempt before another response.
- Budget exhaustion is recorded as a `tool_budget_exhausted` interaction event and a `toolBudget` field on the turn, with counts only, and is shown with the latest turn's consumption.
- Local stdio MCP connections that need no credential can be saved without a secret environment variable. A secret still requires a dedicated variable name, and clearing or changing the variable removes the saved secret instead of passing it to another variable.
- Approved file paths accept real-world vault names. Names may use Unicode letters and marks, such as umlauts and `ß`, plus spaces and `, ( ) & ' ’ + – — →`. This applies to file tasks, local and shared feature requests, offline authoring and live Codex `allowedPaths`. Paths are compared and stored in NFC form, so a decomposed duplicate is rejected. A project's committed `.werk/authoring/feature-request.mjs` keeps the old rule until the script is refreshed.
- The rule now also rejects Windows-reserved characters, device names such as `nul.md`, and segments that end in a dot or space. It also rejects segments over 255 UTF-8 bytes and look-alike secret names.
- Approved paths reject file and parent-folder case aliases and ambiguous Unicode spellings. Existing decomposed names are accepted only when the filesystem resolves the approved spelling to the same entry; distinct look-alike entries are refused. Shared publication also checks newly added paths against tracked names.
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
