# Operate a WerkHome worker

Use this checklist after you [start WerkHome](../tutorials/worker-home-to-main.md) to run
feature requests on a real project, for example a Markdown vault with application
code. The commands run from the central Home. Advanced raw commands use `runtime/bin/apps/worker/cli.mjs`
with the explicit effective `--state-dir` (fresh `Home/state/worker`, or the
retained adopted absolute path). The Windows sections cover Windows PowerShell 5.1, the shell
that ships with Windows 10 and 11.

## Checklist

1. **Start and check the worker.** Run `node worker.mjs`, then
   `node worker.mjs status`. The result includes the webview URL; raw CLI health
   commands require the same explicit effective state.
2. **Connect a provider.** Save the provider with `settings set --file provider.json`,
   then run `provider check --id PROVIDER`. A CLI provider such as Claude Code or
   Codex must already be signed in on the worker machine.
3. **Register the remote project.** In Projects clone the remote, inspect its
   visible path/folder/poll interval, preview workflow publication and separately
   approve the exact committed policy. Implementation runs in a private owned Git
   worktree from committed input, never uncommitted checkout changes.
   [Task worktrees](#task-worktrees) explains where they live.
4. **Grant tools deliberately.** In **Settings → Tools & MCP**, pause new starts
   (`queue pause`) and finish or cancel queued and running work. Grant file tools,
   command presets and MCP connections the request needs. For verified software
   implementation, enable repository files and at least one command preset marked
   **Required feature check**, then save and run `queue resume`.
   Read [Tool limits](#tool-limits) before you plan checks that take minutes.
5. **Submit a small request first.** In **Workboard → New Feature Request**, describe the
   acceptance criteria and approve one or two repository paths when edits are
   needed. Prepare/check the project draft and publish its ready request to Git. Follow its
   progress in the Workboard or with `feature wait` / `file-task wait`, and review
   the patch and required-check evidence before applying or merging changes. See
   [implement a feature](implement-feature.md) for the complete setup.
6. **Answer questions instead of retrying.** A request in `waiting_input` or
   `escalated` waits for you. [Answer it](#answer-protocol); don't create a new task.
7. **Read failures before you resume.** `file-task get --id TASK_ID` shows the
   task error; `interaction turn` shows the error code of the failed attempt.
   Resume with `task resume` or `interaction resume` after you fix the cause.
8. **Clean up.** Delete or archive finished tasks, then
   [remove retained worktrees](#task-worktrees) you no longer need. Stop the worker
   with `node worker.mjs stop`; inspect active/unknown work before another start.

## Recover after a crash or reboot

A worker that crashed, or ran when the machine restarted, leaves its lock files
behind. `status` then reports `stale` with the dead `pid` and the leftover `files`:
`state/worker/portable.json`, `state/worker/worker.lock` and the feature folder's
`_worker.lock`. You don't need to delete them. `start`, `stop` and
`update apply --stop` remove exactly these files and continue as if the worker had
stopped. The worker treats a PID as gone only with proof: the files were written on
this machine, not in a Docker container that shares the project, and no such process
exists or the process now using that PID has a different start identity than the one
recorded with the lock. State written by 0.15.0 or earlier records no host or start
identity and is not recovered automatically: follow the printed files and check once.

If `status` reports `unreachable` instead, the recorded process may still run.
Run the check that `action` names, for example `Get-Process -Id PID` in PowerShell
or `ps -p PID` on macOS and Linux, or `docker compose ps` when the PID was recorded
in a container. Stop that process first; remove the listed files only after it has
exited.

## Write JSON input files on Windows PowerShell 5.1

Worker commands read JSON from `--file PATH`, up to 64 KiB. In Windows PowerShell
5.1, prefer a file over piping to `--file -`:

- `Set-Content -Encoding UTF8` and `Out-File -Encoding UTF8` write a UTF-8 byte
  order mark (BOM). Werk 0.10.0 accepts a leading UTF-8 BOM; 0.9.0 rejects it
  with `Invalid JSON input`. BOM-free files work with both versions.
- Piping text to a native program encodes it with `$OutputEncoding`, which is
  US-ASCII by default. Characters such as `ä` or `ß` reach the worker as `?`.
- `ConvertTo-Json` stops at depth 2 by default and writes nested objects as type
  names. Always pass `-Depth`.

Write a BOM-free UTF-8 file with .NET instead. Use an absolute path, because .NET
does not follow the PowerShell current location:

```powershell
$path = Join-Path (Get-Location) 'provider.json'
$json = @{ provider = @{ id = 'claude-cli'; executable = 'C:\Users\me\.local\bin\claude.exe' } } | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($path, $json)
node runtime/bin/apps/worker/cli.mjs settings set --file provider.json --state-dir state/worker
```

`WriteAllText` without an encoding argument writes UTF-8 without a BOM. To fix an
existing file, read and rewrite it:
`[System.IO.File]::WriteAllText($path, [System.IO.File]::ReadAllText($path))`.
Pass Markdown request bodies with `--markdown FILE` and long answers with
`--file answer.json`, not as command-line arguments, so PowerShell quoting can't
change them. PowerShell 7 has `-Encoding utf8NoBOM` and UTF-8 pipes by default.

## Task worktrees

A request with file approval in an assigned Git repository runs in a worktree
checked out at its accepted base commit. The default location is
`<repository>/.werk/worktrees/<name>`. The worker adds `/.werk/worktrees/` to
Git's local exclude file, which other tools do not read. Exclude `.werk/` in
vault linters, search indexes, file watchers and test runners that scan the whole
project, or set **Settings → Repositories → Task worktree folder** to an absolute
folder outside every checkout. Its parent folder must exist. On Windows, choose
a short path. Existing worktrees keep their recorded location after this setting
changes. See [repository configuration](../reference/configuration.md#assigned-git-repositories).

The webview's **Create request** submits repository requests in the background
and retains the same instructions and request identity while showing preparation
progress. A progress receipt is not confirmation of a saved task; wait for the
admitted session and its Markdown tracking state. If preparation cannot be
confirmed, inspect the current state and use **Retry same request** explicitly.
For compatible CLI creation on large repositories, include `"background": true`
in the `file-task create` JSON and inspect `preparations` in `file-task list`
until the task is available. A client timeout does not prove creation failed;
retain the submitted input and inspect state before submitting again.

Worktrees and interrupted edits survive restart. Deleting a file task removes its
worktree only when it is clean and the worker can verify its ownership. Retain it
explicitly with `file-task delete --id TASK_ID --remove-worktree false`. Inspect
leftovers and preview cleanup before applying it:

```powershell
node runtime/bin/apps/worker/cli.mjs worktrees list --state-dir state/worker
node runtime/bin/apps/worker/cli.mjs worktrees prune --dry-run --state-dir state/worker
node runtime/bin/apps/worker/cli.mjs worktrees prune --id NAME --state-dir state/worker
```

Pause new starts and drain queued, running and preparing work before pruning;
the preview is available at any time. Cleanup skips worktrees still used by a
file task. It preserves changed worktrees by default and reports a reason for
each retained directory. Only after reviewing their contents, use
`--discard-changes true` to discard uncommitted/untracked files or an interrupted
checkout. A detached HEAD with additional commits, an operator lock, or any
symbolic link or junction inside always requires manual review.

Do not delete worktree folders with Explorer or `Remove-Item -Recurse`: a tool
may have created a link or junction that reaches outside the worktree. The
worker's owned-cleanup commands apply the documented identity and link checks.
Back up repositories and retained worktrees separately from private worker state.

## Tool limits

In **Settings → Queue & duration**, configure the accepted invocation budget.
Defaults are six hours, 128 tool calls and a five-minute ceiling per command.
Command presets and CLI grants can set shorter per-tool timeouts in **Settings →
Tools & MCP**; leaving a timeout blank inherits the global command ceiling. MCP
calls default to 30 seconds and can use a per-connection override up to 15 minutes
for stdio or five minutes for HTTP. Remaining invocation time and cancellation
cap every operation.

Long builds and test suites can run as approved command presets. Set the global
command ceiling and total invocation duration high enough for the intended checks
and repair iterations. A prepared dispatch keeps its captured limits; new
follow-up attempts capture current execution limits. See
[execution limits](manage-model-tools.md#execution-limits) for ranges, overrides
and compatibility.

Requests without repository-file approval have no task worktree. Their command
presets and stdio MCP servers normally start in the worker's empty private
`chat-workspace`. A grant can explicitly select **Working directory in chat →
Live checkout of repository "ID"** under **Settings → Tools & MCP**. That tool
then runs in the assigned checkout and can affect uncommitted work; use this only
for reviewed tools whose host-account authority is appropriate. Repository-file
requests continue to use their pinned worktree. Built-in file tools remain
worktree-only. See [Chat tool directories](manage-model-tools.md#run-chat-tools-in-a-repository-checkout).

## Answer protocol

A model that needs a decision returns a structured question instead of a patch,
and the task waits in `waiting_input` (or `escalated` for a decision outside its
authority). Answer it once with the session ID, question ID and revision:

```powershell
node runtime/bin/apps/worker/cli.mjs interaction get --id SESSION_ID --state-dir state/worker
node runtime/bin/apps/worker/cli.mjs interaction answer --id SESSION_ID --question-id PENDING_ID --if-match REVISION --key answer-001 --file answer.json --state-dir state/worker
```

`answer.json` contains `{"answer":"..."}`, written as described above. If the
command loses its acknowledgement, repeat it with the same key. The answer starts
a new attempt with the same approved scope. Proposal tasks return a patch JSON
object. Eligible implementation tasks edit their retained worktree, run the frozen
required checks and return a readable summary; the worker captures the actual
patch and check receipts. See the
[model interaction contract](../reference/model-interaction.md). The
[answer and resume guide](answer-and-resume-worker.md) covers cancellation,
checkpoints and events.
