# Project worker upgrade retrospective (0.15)

Date: 2026-10-24. Scope: upgrading the operator's LACForce project worker from 0.14.0
to 0.15.0, restarting it after a machine reboot and checking the Claude Code CLI
provider afterwards. LACForce is an Obsidian vault and Git repository on native
Windows 11. "Operator-only" means one operator, everything gitignored, the team's
shared intake off and the Claude Code CLI as provider. It continues the
[0.13 reinstall retrospective](project-worker-install-retrospective-0.13.md) and the
[0.9–0.11 retrospective](project-worker-retrospective-0.9-0.11.md) and does not replace
the [current documentation](../index.md). The Outcome column describes the
`fix/worker-015-install-friction` branch; its changes are listed under `[Unreleased]`
in the changelog and are not part of any release yet.

## What worked

- **Verified in-place replacement.** Once the archive was extracted by hand,
  `update apply --stop --in-place --from <folder>` verified the release, replaced the
  files and restarted the worker. The `--in-place` route that 0.13 added avoids the
  directory-handle failures that earlier upgrades hit.
- **Stale state was diagnosable.** After the reboot `status` named the PID recorded in
  `.werk/worker/portable.json`. A `Get-Process -Id` check proved it was gone, so moving
  the leftover files aside was a verified step, not a guess.
- **Generated-block migration.** The first start after the upgrade migrated the
  generated block of a legacy request note and kept the pre-migration copy, so nothing
  was lost (see item 3 for the side effect).
- **Provider check.** The retry of `provider check --id claude-cli` returned
  `authenticated`; the CLI login itself was fine.
- **Explicit authentication mode.** Existing provider connections come out of an
  upgrade as `legacy`, and dispatch is refused until the operator chooses a mode.
  Setting `authenticationMode: cli-account` for `claude-cli` was one settings change.
  This is the intended 0.15 behavior, documented in
  [use the worker webview](../how-to/use-worker-webview.md), so it is a step of the
  upgrade and not friction.

## Friction and outcome

| # | Friction | Impact | Outcome |
| --- | --- | --- | --- |
| 1 | `update apply` failed with `spawnSync tar ETIMEDOUT`. The 0.15.0 archive has 2,982 entries. Extraction took 134 s with the System32 bsdtar and 178 s with Git's GNU tar, against a fixed 60 s bound. | The update could not run at all. The operator downloaded and extracted the archive by hand and ran `update apply --stop --in-place --from <dir>`. | Fixed in this change: extraction now allows the larger of 300 s and 200 ms per listed entry (about 596 s for 2,982 entries), listing allows 120 s, and a timeout names the operation, the bound and the `update apply --from` route. |
| 2 | After a reboot, `status` and `update apply --stop` reported `unreachable` for a dead PID in `.werk/worker/portable.json`, and `start` refused with `Feature folder is locked` (`_worker.lock`, same dead PID). | The worker could neither be restarted nor updated. The operator checked that the PID was dead and moved `portable.json`, `worker.lock` and `_worker.lock` aside by hand. | Fixed in this change: `status` reports `stale` when the recorded PID on this host is gone or reused, listing the exact files, and `start`, `run`, `stop` and `update apply` remove them and continue as stopped. Open for this upgrade: state written by 0.15.0 or earlier carries no start identity and stays `unreachable`, so the manual check remains once. |
| 3 | A legacy request note the operator had not touched got its generated block migrated, and the pre-migration copy went to `_conflicts/`. Later every start wrote another copy: three copies after three starts, differing only in worker-owned fields. | Growing copies in `_conflicts/` that looked like edit conflicts, although the operator had not edited the note. | Fixed in this change: worker-owned rewrites delete the displaced copy when it is still identical to what the worker expected, so a copy stays only when an editor saved into the note meanwhile. Copies already in `_conflicts/` are not cleaned up. |
| 4 | The first `provider check --id claude-cli` after a start returned `authentication: unknown`. A cold `claude auth status` took about 4.4 s against a 5 s probe deadline. An immediate retry succeeded, and it happened again after the next restart. | A healthy login looked broken after every restart, and the operator had to know to retry. | Fixed in this change: probes wait up to 15 s, a failed login probe is retried once, and the webview and CLI wait 60 s for the check. |
| 5 | With no committed delivery policy, the default `reviewDirectory: 'feature-reviews'` adds an untracked `feature-reviews/` folder at the repository root, although an operator-only worker commits nothing. | A permanently dirty `git status`. The operator added `/feature-reviews/` to `.git/info/exclude`. | Fixed in this change: `init --intake local` appends `/feature-reviews/` to the checkout's local exclude file and reports it. It skips non-Git folders, projects below the checkout root and review folders that already hold tracked files. Open: an existing installation keeps its manual exclude; a project below the checkout root has to add the line itself. |
| 6 | Git Bash rewrote `api --path /api/requests` into a Windows path (MSYS path conversion), and the CLI answered `Use a local API path and supported method`. | A valid command looked invalid, and the message gave no hint about the shell. | Fixed in this change: a `--path` that looks like `C:/…` now says Git Bash converted it and to rerun with `MSYS_NO_PATHCONV=1` or from PowerShell, and the delivery-policy and portable-app docs say so. The conversion itself cannot be prevented by the CLI. |
| 7 | With the host at about 95% CPU, `start` failed with `Startup deadline exceeded` (a fixed 25 s). The launched `cli.mjs _run` child stayed alive for more than 5 minutes without listening, while `status` said stopped. | A leftover process the worker did not report, and a restart that failed under load. | Fixed in this change: a failed start asks the launched process to stop, waits 10 s, then ends only that child's own process tree and removes the state it left. The deadline grows to 120 s, and `--startup-timeout-ms` or `WERK_STARTUP_TIMEOUT_MS` (5000–900000) raises it; the update restart scales its exec timeout with it. |

## Notes

- **Items 1 and 7 share a cause.** Fixed time bounds were tuned for a quiet developer
  machine. A 2,982-entry archive and a busy host both exceed them by a wide margin, and
  the failure left an operator-visible mess, not just an error. The new bounds scale
  with the work or can be set, and the errors name the next step.
- **Item 2 is not fixed for this upgrade.** The recovery relies on the host and start
  identity that workers now record. The 0.15.0 worker wrote only the PID, so the
  operator's own state still needs the one manual check; later crashes are covered once this
  change is released. The documentation says so
  in [operate the project worker](../how-to/operate-project-worker.md).
- **Item 8 is documentation, not a defect.** The explicit
  authentication choice is easy to meet unprepared during an upgrade. A line in the
  upgrade instructions would save the detour; this change does not add one.
- **Validation of this branch ran out of disk.** The host's drive filled to 0 bytes free
  while the branch was tested, and test runs failed with `ENOSPC`. Werk's test suites
  extract releases and spawn real workers, so they and Windows hosts in general need
  headroom. An update already refuses to run without room for a state backup.
- **Host-only test failures.** Some suites fail on this host and on `main` alike:
  candidate-tools marker waits, settle timeouts and symlink `EPERM`. They were reported
  and left alone; they are not caused by this change.
- **Pattern.** Items 2, 3, 5 and 7 are one theme with the 0.13 report: a long-lived
  worker in a real, busy repository leaves state behind after crashes, reboots and
  upgrades. The fixes make that state provable, removable and quiet instead of
  leaving it to the operator.
