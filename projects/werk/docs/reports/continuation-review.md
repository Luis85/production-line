# Werk continuation review

Reviewed on 2026-10-12. This pass continues the [first hardening review](production-review.md) using Forge 0.1.0, Node 24.19.0, parallel implementation agents and independent source review. The [acceptance criteria](continuation-acceptance.md) were recorded before implementation.

## Result

The product now has a usable commit-pinned context preview, paginated administrative APIs, conservative local evidence retention, clearer recovery behavior and a tested stopped-writer restore procedure. **The integrated check passes 226 tests, with zero failures or skips**, including 50 new regressions. This remains a mock execution service: provider execution, publisher fencing and human review/merge reconciliation are unfinished.

## Changes and evidence

| Area | Delivered behavior | New regression cases |
| --- | --- | --- |
| Requirement context | `context resolve` reads an exact commit and regular Git blobs, validates ready frontmatter, follows bounded explicit dependencies, and emits a deterministic manifest with raw-byte hashes. Rejects unsafe, missing, ambiguous and unsupported references; ignores replace refs and mutable checkout content; blocks network fetching | 11, including invalid UTF-8 Git paths and BOM preservation |
| Pagination and persistence | Optional bounded pages for tasks, workers and task events, matching CLI options and importer traversal. Keyset cursors retain an insertion watermark; worker heartbeats do not reorder pages. Count and serialized-byte budgets bound responses. Strict numeric query parsing and a 256-row lease-expiry sweep prevent bulk payload materialization | 9, including concurrent inserts/heartbeats, byte limits, restart, cursor misuse and large expiry sweep |
| Worker retention | Keep latest 1000 locally acknowledged pairs by default, configurable 0–100000. Durable receipts bind worker and snapshot hashes. Both telemetry and terminal acknowledgments are required; restart skips acknowledged history and safely resumes partial cleanup | 13, including real HTTP acknowledgments, completion retry without adapter rerun, corruption, symlinks and interrupted cleanup |
| HTTP and portfolio integrity | Reject duplicate Content-Type before mutation. Reject remote summaries that double-count worker capacity. Overflowing aggregate groups become unknown with partial status instead of rounded totals | 5, including real HTTP requests and safe-integer boundaries |
| UI recovery | Expired credentials stop polling and focus reconnect without losing drafts; obsolete failures cannot expire a new session. Logout clears hidden identities and filters. Paused worker views retain error severity and identify stale data | 11 plus desktop/mobile Chromium checks |
| Restore | Copy stopped Factory/line databases, worker journal and credential identity to a new root. Replay pending evidence and lost acknowledgments without duplicate completion, verify intake/claim identity, SQLite integrity and preserved backup database hash | 1 real filesystem/SQLite/journal rehearsal |

The context command is a completed foundation slice, not all of P0-01. That backlog item is Active because server-owned repository/project bindings and assignment integration remain open. Thirteen other original product items remain Open. Six continuation improvements are tracked separately.

## Verification

- `npm run check`: TypeScript, independent Factory/orchestrator/worker builds, **226 passed, 0 failed, 0 skipped**.
- `npm run audit:dependencies`: **0 known vulnerabilities** at review time.
- Forge workflow drift check: one generated workflow in sync.
- Focused per-lane suites and isolated builds preceded the coherent integrated run. Independent reviews covered pagination, HTTP/portfolio changes, retention ordering and context object-read safety; identified UTF-8/BOM and checkpoint-failure edges were resolved before the final gate.
- Chromium checked actual source HTML/renderer with deterministic HTTP fixtures at 1440px desktop and 390px mobile. Expiry/reconnect, pause/error and manual retry passed with no page errors or document overflow. These browser checks verify UI response handling, not a live provider or deployed authorization system.
- This pass did not rerun container qualification or cross-platform CI. The previous three-container build/health evidence remains in the first report; source changed afterward. Full Compose lifecycle, Windows/macOS execution and broader browser/screen-reader coverage remain unverified here.
- Final Forge document and backlog gates are recorded in the delivery note below.

## User and operator documentation

- [Pinned context command and supported subset](../reference/pinned-context.md).
- [API pagination contract](../reference/api.md).
- [Worker retention and migration limits](../how-to/worker-retention.md).
- [Stopped-writer backup/restore](../how-to/operations.md#backup-and-restore).
- [Forge tools and improvement report](cli-continuation-report.md).

## Browser evidence

- Factory: [desktop](../evidence/archive/continuation-factory-desktop.png), [mobile](../evidence/archive/continuation-factory-mobile.png).
- Orchestrator: [desktop](../evidence/archive/continuation-orchestrator-desktop.png), [mobile](../evidence/archive/continuation-orchestrator-mobile.png).
- Worker: [desktop](../evidence/archive/continuation-worker-desktop.png), [mobile](../evidence/archive/continuation-worker-mobile.png).

## Remaining gaps

1. Connect server-owned project configuration and pinned manifests to intake/import/assignments. Implement isolated provider execution, durable fenced publication, head-specific checks and human review/merge reconciliation. No live-provider or Git publication permission is inferred from requirement text.
2. Legacy no-query task/worker/event clients remain unbounded for compatibility; UI/MCP have not migrated. The importer pages network responses but still holds its inventory in memory. Cursor watermarks freeze insertion membership, not mutable task status, and traversal must restart after restore/VACUUM. Lease expiry uses bounded batches inside one transaction, whose duration still grows with backlog.
3. Retention covers only locally checkpointed pairs. Unacknowledged and older uncheckpointed history, failed cleanup, repository artifacts and server telemetry need separate capacity/retention policies. No evidence is deleted merely because a lease expired or an outbox appears empty.
4. The restore rehearsal qualifies local stores and journals, not full HTTP fleet restart, provider sessions, cloud volume recovery, hardware power failure or deployment RTO/SLO. Sustained load, disk exhaustion, operational ownership, deployment TLS/access controls and provider credentials remain separate work.
5. Werk changes remain local in the shared production-line workspace. The upstream Forge PR is a separate CLI change; it does not publish or deploy Werk.

## Delivery note

Product check complete. Forge strict vault check: 287 files, zero errors/warnings and three pre-existing informational Dockerfile attachment findings. Backlog check: 26 items, zero errors/warnings; 12 Done (six from each pass), 13 Open and one Active. Workflow drift check passes. The [CLI report](cli-continuation-report.md) records the separate upstream PR and its validation.

The dedicated Forge agents delivered [PR 24](https://github.com/Luis85/agent-cli/pull/24) for search exclusions and browser diagnostics. It is open and unmerged; local checks are recorded in the CLI report, and remote CI was not yet listed at verification.
