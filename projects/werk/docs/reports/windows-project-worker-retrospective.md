# Windows project worker retrospective (0.3–0.7)

Date: 2026-10-16. Scope: installing a project worker in an Obsidian/Git project on
native Windows 11, operating it with the local Claude Code CLI, upgrading it
through five releases and preparing shared Git intake for a team. This records
friction observed in that rollout and what changed because of it. It does not
replace the [current documentation](../index.md).

## Friction and outcome

| # | Friction | Impact | Outcome |
| --- | --- | --- | --- |
| 1 | Subscription CLI providers were refused on native Windows | Worker could not use the installed Claude Code login | Fixed in 0.4.0: Claude Code CLI runs on Windows; prompt passed as a private file to avoid command-line limits |
| 2 | A failed `status.json` replacement (`EPERM` from a scanner/indexer lock) ended the worker | Standalone worker stopped every few minutes on one machine | Fixed in 0.5.0: status snapshots are non-fatal; longer Windows retry window |
| 3 | Repository Git calls opened a console window each time | Visible terminal flashes while the worker polled | Fixed in 0.5.1/0.6.0: all launches hidden; one shared launcher owns process creation |
| 4 | Shared intake had no CLI command | Configuration required the webview or raw authenticated HTTP | Fixed here: `shared status`, `shared sync`, `shared configure` |
| 5 | Local folder intake claimed a shared Git request before shared intake was bound | Worker metadata was written into a team file; a vault sync pushed it and the request could no longer be claimed by shared intake | Fixed here: the local folder never admits requests carrying a `templateId` and reports how to process them |
| 6 | A deep Windows state directory was rejected only at publication, after a claim | A request stayed claimed with a late, unexplained error | Fixed here: the path is checked when shared intake is configured, with the measured length and a remedy |
| 7 | Instruction profiles get a random per-worker `definitionId` | A committed team template must embed one worker's ID and be edited when the worker host changes | Open: consider a stable, name- or digest-addressed profile reference |
| 8 | Portable apps upgrade by hand (stop, back up state, replace folder, restart) | Five manual swaps in two days; easy to skip the backup | Open: a guarded `update` for portable apps with automatic state backup |
| 9 | `feature setup` writes check files and the Base to the repository root and reviews to `feature-reviews/` | Root clutter in structured repositories; layout had to be pre-seeded in `feature-workflow.json` | Open: setup flags for the review, check and Base locations |
| 10 | Windows-local test runs fail without symlink privilege or `pwsh` | Fourteen environment-only failures hide real regressions locally | Open: skip consistently with an explicit reason, as some suites already do |

## Notes

- Items 4–6 shared a root cause: the team workflow assumes the worker is bound
  before any team request reaches its checkout, but nothing enforced that order.
  The worker now refuses the unsafe path instead of relying on documentation.
- The Windows CI runners repeatedly passed where a developer machine failed
  (scanner locks, path depth, missing privileges). Native Windows qualification
  on a developer-like machine would have found items 2, 3 and 6 earlier.
