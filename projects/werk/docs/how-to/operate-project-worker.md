# Operate a project worker

Use this checklist after you [install a project worker](project-worker.md) to run
feature requests on a real project, for example a Markdown vault with application
code. The commands run from the project directory with the portable worker in
`bin/apps/worker`. The Windows sections cover Windows PowerShell 5.1, the shell
that ships with Windows 10 and 11.

## Checklist

1. **Start and check the worker.** Run `node bin/apps/worker/cli.mjs start`, then
   `status` and `health`. `status` returns the webview URL. Keep one state
   directory per worker and pass the same `--state-dir` to every command.
2. **Connect a provider.** Save the provider with `settings set --file provider.json`,
   then run `provider check --id PROVIDER`. A CLI provider such as Claude Code or
   Codex must already be signed in on the worker machine.
3. **Assign the repository.** Accept the detected checkout in the Taskboard, or
   run `repository status` and `repository accept --discovery-id ID`. File tasks for an assigned repository run in their own Git
   worktree, created from a commit, never from uncommitted changes.
   [Task worktrees](#task-worktrees) explains where they live.
4. **Grant tools deliberately.** In the Dashboard, open **Tool access** with new
   starts paused (`queue pause`) and nothing running. Grant file tools, command
   presets and MCP connections the task needs, then save and run `queue resume`.
   Read [Tool limits](#tool-limits) before you plan checks that take minutes.
5. **Submit a small request first.** Approve one or two paths, submit, then follow
   it with `feature wait` or `file-task wait`. Review the patch before you apply it.
6. **Answer questions instead of retrying.** A request in `waiting_input` or
   `escalated` waits for you. [Answer it](#answer-protocol); don't create a new task.
7. **Read failures before you resume.** `file-task get --id TASK_ID` shows the
   task error; `interaction turn` shows the error code of the failed attempt.
   Resume with `task resume` or `interaction resume` after you fix the cause.
8. **Clean up.** Delete or archive finished tasks, then
   [remove retained worktrees](#task-worktrees) you no longer need. Stop the worker
   with `stop`; it drains running work and keeps its state.

## Write JSON input files on Windows PowerShell 5.1

Worker commands read JSON from `--file PATH`, up to 64 KiB. In Windows PowerShell
5.1, prefer a file over piping to `--file -`:

- `Set-Content -Encoding UTF8` and `Out-File -Encoding UTF8` write a UTF-8 byte
  order mark (BOM). Werk 0.9.0 rejects such a file with `Invalid JSON input`.
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
node bin/apps/worker/cli.mjs settings set --file provider.json
```

`WriteAllText` without an encoding argument writes UTF-8 without a BOM. To fix an
existing file, read and rewrite it:
`[System.IO.File]::WriteAllText($path, [System.IO.File]::ReadAllText($path))`.
Pass Markdown request bodies with `--markdown FILE` and long answers with
`--file answer.json`, not as command-line arguments, so PowerShell quoting can't
change them. PowerShell 7 has `-Encoding utf8NoBOM` and UTF-8 pipes by default.

## Task worktrees

A file task for an assigned repository runs in a Git worktree at
`<repository>/.werk/worktrees/<name>`, checked out at the task's base commit. The
worker adds `/.werk/worktrees/` to `.git/info/exclude`, so Git ignores it. Tools
other than Git don't read that file: exclude `.werk/` in vault linters, search
indexes, file watchers and test runners that scan the whole project folder.

Checking out a large repository takes time, and the task request returns only
after its worktree exists. On a repository with a large history or many files,
allow up to a minute for task creation.

The worker keeps a task worktree, including interrupted edits, so that tools and
reviews stay pinned to the same directory. Deleting a task in Werk 0.9.0 does not
remove its worktree. To clean up after you delete the task:

```powershell
git worktree list
git worktree remove .werk/worktrees/NAME
```

`git worktree remove` refuses a worktree with changes; inspect it before you add
`--force`. Don't delete the folder with Explorer or `Remove-Item -Recurse`: if a
tool created a junction or symbolic link inside it, a recursive delete can follow
the link and delete files outside the worktree. Run `git worktree prune` after a
folder was removed by other means.

## Tool limits

Each model invocation in Werk 0.9.0 can use at most 64 tool definitions and make
32 tool calls. All calls share a two-minute window that starts with the first call.
Each command preset or MCP call stops after 30 seconds, and a web fetch after 10
seconds. When the calls or the window run out, further tool calls fail and the
model must finish without tools. A long test suite or build therefore doesn't fit
in a command preset: run it yourself, or split it into checks that finish in
seconds. See [execution limits](manage-model-tools.md#execution-limits).

Chat sessions have no task worktree. Their command presets and stdio MCP servers
start in a private, empty `chat-workspace` folder in the worker state directory,
not in your project. Use a file task when a tool needs the project files.

## Answer protocol

A model that needs a decision returns a structured question instead of a patch,
and the task waits in `waiting_input` (or `escalated` for a decision outside its
authority). Answer it once with the session ID, question ID and revision:

```powershell
node bin/apps/worker/cli.mjs interaction get --id SESSION_ID
node bin/apps/worker/cli.mjs interaction answer --id SESSION_ID --question-id PENDING_ID --if-match REVISION --key answer-001 --file answer.json
```

`answer.json` contains `{"answer":"..."}`, written as described above. If the
command loses its acknowledgement, repeat it with the same key. The answer starts
a new attempt with the same approved file snapshots. A file task's final reply must
be one patch JSON object, as described in the
[model interaction contract](../reference/model-interaction.md). The
[answer and resume guide](answer-and-resume-worker.md) covers cancellation,
checkpoints and events.
