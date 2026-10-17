# Project worker retrospective (0.9–0.11)

Date: 2026-10-17. Scope: operating the LACForce project worker (an Obsidian/Git
vault with an Angular prototype) on native Windows 11 with the Claude Code CLI
provider, upgrading it 0.9.0 → 0.10.0 → 0.11.0, moving task worktrees outside the
checkout and switching the project from proposal tasks to verified
implementation with a required feature check. It continues the
[0.3–0.7 retrospective](windows-project-worker-retrospective.md) and does not
replace the [current documentation](../index.md).

## What worked

- `update check` / `update apply --stop` replaced 0.9.0 with 0.10.0 in one step,
  verified the release, backed up state and restarted the worker with its
  recorded launch arguments.
- `feature setup` refreshed the committed authoring script after the 0.11.0
  upgrade through `.werk/authoring/manifest.json`; the first refresh from an
  unrecorded script needed one explicit `--if-match`, as documented.
- `worktrees prune --dry-run` and `worktrees prune` removed three stale
  ownership records whose folders were already gone, without touching anything else.
- Implementation mode was configured entirely from the CLI: `settings set` for
  the worktree folder and command ceiling, `tool-access set` for a required check,
  `definition update --dry-run` / `--if-match` for the instruction profile.
- The 0.10.0 operator how-to (Windows PowerShell 5.1 JSON input, worktrees,
  tool limits) answered most questions before they became problems.

## Friction and outcome

| # | Friction | Impact | Outcome |
| --- | --- | --- | --- |
| 1 | `update apply` failed with `Could not move …\bin\apps\worker (EPERM)` on 0.10.0 → 0.11.0. The holders were .NET MCP servers of seven running Claude Code sessions, started with the project directory as working directory, holding directory handles across `src/worker/dist`. Restart Manager reports no file locks for directory handles; the folder stayed locked for over an hour | Update impossible without closing unrelated agent sessions; the old version was correctly restarted | Worked around by replacing the files in place against the verified release manifest, with manual app and state backups. The error and the troubleshooting guide now name directory handles of long-running processes started in the project (this change). Open: an explicit, manifest-verified in-place update mode |
| 2 | `tool-access set --file` rejected an edited `tool-access get` output once `expectedRevision` was added: read-only fields were stripped only when `expectedRevision` was absent, and the errors (`Use the documented tool access update fields.`, `… MCP connection fields.`) did not name the field | Three failed saves; reading the worker source to find `hasSecret` and `discoveredTools` | Fixed in this change: read-only view fields are always dropped, a conflicting `revision` is refused, and unknown fields are named |
| 3 | `settings set` with an invalid `repositories.worktreeDirectory` (a shell had dropped the backslash: `C:werk-worktrees`) reported `Repository path must be absolute on the worker machine.` | The message pointed at the correct repository assignment instead of the new folder | Fixed in this change: the task worktree directory reports its own field |
| 4 | `definition update --file profile.yaml` failed with `Invalid JSON input`; the command expects `{"name","yaml"}` JSON wrapping the YAML | The committed profile had to be wrapped in JSON by a script | Fixed in this change: `.yaml`/`.yml` files are accepted directly |
| 5 | An existing custom MCP tool reset the task worktree (`git checkout -- .`, `git clean`) to test proposals; another wrote generator output into the worktree | In implementation mode the first would delete the model's candidate and the second adds unapproved files that fail verification | Both were removed from the LACForce grants. Documented in this change: tools granted to implementation requests must not reset or write outside approved paths |
| 6 | A clean task worktree has no dependencies; the project's `harness check` needs Prettier and the frontend checks need `node_modules` | A required check must install dependencies itself; linking the checkout's `node_modules` would make the worktree unremovable (junctions) | Solved in the project's check script with `npm ci` inside the worktree (about four minutes on the first run, then reused); command ceiling raised to 15 minutes. Documented in the implementation guide (this change) |
| 7 | The npm bundled with Node in `Program Files` (11.19.0) is older than the user-level npm (11.21.1) and below the project's engine range; only an administrator can update it | Frontend dependencies could not be installed by the bundled npm | Project-side: the check script prefers the user-level npm. Not a Werk defect |
| 8 | Worker fixture processes from `portable-update` and `worker-npm` tests (`werk update running …`, `werk npm project …`) were still running a day later with exited parents | Four detached workers on the developer machine | Started before the 0.10.0 fixture cleanup; not reproduced since. Watch for recurrence |
| 9 | The operator how-tos ship with the release documentation and Storybook, not in the portable app folder | The worker host had to read them on GitHub | Open: link the guides from `update check` output or the app README |

## Notes

- Items 2–4 share a pattern: the CLI accepted the documented happy path but
  refused near-misses with messages that did not identify the offending field or
  the expected format. Naming the field turns a source-reading session into a
  one-line correction.
- Item 1 extends the scanner-lock finding of the 0.3–0.7 retrospective: on a
  developer machine, long-running agent tooling started in the project folder is
  a more persistent lock source than antivirus or indexers.
- Implementation mode changes the meaning of existing tools: anything that
  previously operated on a scratch worktree now operates on the candidate.
  Review every grant when enabling a required check.
