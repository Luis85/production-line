# Project worker reinstall retrospective (0.13)

Date: 2026-10-18. Scope: removing a project worker that had been upgraded from 0.9 to
0.12 in the LACForce project, then installing Werk 0.13.0 fresh for operator-only use.
LACForce is an Obsidian vault and Git repository on native Windows 11 with 3,102 tracked
files (87.6 MiB). "Operator-only" means one operator, everything gitignored, the
team's shared intake off and the Claude Code CLI as provider. The goal was to prove
verified implementation end to end. It continues the
[0.9–0.11 retrospective](project-worker-retrospective-0.9-0.11.md) and does not replace
the [current documentation](../index.md).

## What worked

- **Release and setup.** The release verifier and `init` produced a working worker in
  one step. Repository discovery, `repository accept`, `provider check` and settings
  were all scriptable.
- **Profile import.** `definition import --file profile.yaml --name …` (added in 0.12)
  imported the committed profile directly.
- **Large-repository limits.** Configurable inspection limits (0.13) made verified
  implementation possible for the 87.6 MiB vault. With `candidateSourceMaxBytes` at
  256 MiB, the first verified request on LACForce passed its required check and the
  done gate (`verificationPassed: true`, one required check).
- **Model questions.** Twice the model stopped with a precise question instead of
  working around an environment problem: the inspection limit, and the failing check
  described below.
- **Worktree folder and prune.** Task worktrees in an external `repositories.worktreeDirectory`
  kept the vault clean. `worktrees prune` and `git worktree remove` cleared the old
  worker's worktrees safely.

## Friction and outcome

| # | Friction | Impact | Outcome |
| --- | --- | --- | --- |
| 1 | Approved tool processes run under the Windows PowerShell job supervisor. Windows PowerShell appends `;.CPL` to PATHEXT, and the worker passes no PATHEXT, so the child process starts with `PathEXT=.CPL`. Its `cmd.exe` cannot resolve `node`, so `npm ci` lifecycle scripts fail (`"node" is not recognized`). This happens only under containment. | A required check that installs dependencies failed twice. The model correctly asked instead of claiming success. The 0.9–0.11 retrospective had wrongly blamed a missing PATH. | Reproduced with the worker's own `runProcess`, with no model involved. Worked around in the project check script. Fixed in this change: containment restores the caller's PATHEXT, and approved tools receive PATHEXT and ComSpec. |
| 2 | A profile with `version: "17"`, an unsupported Docker Agent schema version (the operator had bumped it), imported without warning. A request selecting it validated as `valid`, then waited with `This definition includes unsupported features…`, which named neither the key nor the fix. | The first test request sat in `waiting`. Finding the cause took a `definition preview`. | Fixed in this change: the error names the unsupported items and both remedies, preview, import and update return warnings, and request validation reports the problem before submission. |
| 3 | `update apply` again failed with EPERM, as it had in 0.11 and 0.12. .NET MCP servers of open Claude Code sessions, started in the project folder, hold directory handles in `bin/apps/worker`. | Every upgrade needed a hand-made verified in-place replacement. | Fixed in this change: an explicit `update apply --in-place` (and `rollback --in-place`) replaces the files against the verified manifest, with a retained copy and a tree verification. The lock error suggests it. |
| 4 | `init` writes `fr-ready-check.json`, `fr-done-check.json`, `Feature Requests.base` and `package.json` to the project root, with no option to place or skip them. | Four new root files in a structured vault. They had to be moved by hand and the workflow and Base edited. This was already open as item 9 of the 0.3–0.7 retrospective. | Fixed in this change: `--workflow-dir DIR` and `--no-npm`. |
| 5 | `env init` appends `.env` and `!.env.example` unless `.gitignore` ends with exactly that block, so it duplicated rules the project already had. | The tracked `.gitignore` was modified. The operator-only setup had to revert it. | Fixed in this change: only missing lines are appended. |
| 6 | The default 10 s client timeout was exceeded by `settings set` (repository assignment and worktree folder), `interaction answer` and a `feature wait` poll. Each operation still succeeded on the server. | Three misleading client failures that each needed a status check before retrying. | Fixed in this change: a 30 s default and 120 s for `settings set`. The wait loop already tolerates slow polls since 0.13. |
| 7 | `Use a valid Command executable.` named neither the entry nor the reason. A shell had collapsed backslashes into a control character. | Required source reading to diagnose. | Fixed in this change: tool-access errors name the entry and the reason. |
| 8 | `definition import` cannot set the stable reference, so `definition ref` is a second command. | One extra step and a definition ID to copy. | Fixed in this change: `definition import --ref`. |
| 9 | The operator wants the worker as a full-time developer that runs the project's code generators. Generators write whole folders and large files, but an implementation scope approved only exact files (at most 32) within fixed bounds of 24 KB per file, 48 KB in total and a 120 KB review patch. | Generator-driven requests could not be scoped or exceeded the bounds, so verified implementation was limited to small hand edits. | Fixed in this change: folder approvals and configurable approved-content limits (patch ≤ 4 MiB). |
| 10 | There is no uninstall or footprint listing. Removing the old worker meant collecting the app, `.werk/`, the request folder, four skill folders, the Codex guide, retained update folders and Git-registered task worktrees by hand. Windows refused to recycle folders that other processes held open. | A manual inventory, plus a copy-then-delete backup outside the project. | Open: a `footprint` or `uninstall --dry-run` command that lists every installed path and owned worktree. |
| 11 | Operator-only use is not a first-class setup. `init` always generates the shared Git template, which the local folder intake refuses (it carries a `templateId`), and it enables repository watching on accept. | The operator wrote a local request template by hand and turned watching off so the worker would not fast-forward a busy checkout. | Open: an `init --intake local` that generates a local request template and leaves watching off. |
| 12 | `integrations plan` rejects `--request-timeout-ms`, although `help` lists it as a general client option. | Cosmetic inconsistency. | Open. |

## Notes

- **Item 1 corrects an earlier diagnosis.** The 0.9–0.11 retrospective attributed the
  failing check to a minimal environment without Node on PATH, and then withdrew
  that claim. The real cause is PATHEXT under containment. It only appears when the
  child runs through the PowerShell supervisor, which is why every simulation outside
  the worker passed.
- **Pattern from items 2 and 5–8.** As in the previous retrospective, the CLI accepted
  input and then failed later, or reported a generic error. Validating early and
  naming the field is still the cheapest operator improvement.
- **Pattern from items 3, 4, 10 and 11.** Installing into a real, busy vault is a
  different operating environment from a clean demo project: other agents' processes,
  strict Git hygiene and a single operator. These items make that path explicit
  instead of manual.
