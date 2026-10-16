# Manage model tools from the worker

Open **Settings → Tools & MCP** in the unlocked worker webview. Its setup
shortcut opens the editor directly. Tool access is separate from provider sign-in,
execution profiles and agent definitions. All grants start disabled, including
after upgrading an existing worker.

Grants apply to local requests using the worker's configured
model connections. Results from granted tools are sent to the task's selected
model provider. Grant only the content and operations that provider may receive.
The separate orchestrator execution adapter retains its own execution policy;
these controls do not change simulated tasks into live executions.

## Grant built-in tools

Pause new starts, then finish or cancel queued and running work. Open **Settings →
Tools & MCP**, edit the grants and save. Resume new starts when the saved policy is
correct. Saving requires the worker to be paused and idle so an active invocation
cannot retain a grant that appears revoked in the editor.

| Grant | What the model can do |
| --- | --- |
| Repository files | List, read and search files in an approved task's Git worktree. New implementation requests can also edit their explicitly approved paths when a required feature check is enabled. Requests without an approved task worktree have no repository file tools. |
| Command presets | Run the exact executable and arguments you configure. The model chooses a preset; it cannot supply an arbitrary shell command. |
| CLI tools | Run a project command-line tool in the task worktree with arguments the model chooses, within the commands, flags and refusals you allow. See [Give the model a project CLI](#give-the-model-a-project-cli). |
| Web origins | Fetch HTTP(S) content from the origins you allow. This is page fetching, not a search-engine connection. |

List, read and search tools remain read-only. They exclude Git metadata, reject
path escapes and symlinks, and bound returned content. For a new Git-backed file
request, enable file access and at least one enabled command preset marked
**Required feature check**. The request then captures its approved paths and
required checks: the model can edit those paths in its retained task worktree,
run the checks and repair failures. Every required check must pass on the final
candidate before review. The review patch comes from that worktree's actual
changes; the source checkout remains separate and human review is still required.

Older requests and new requests without that implementation scope retain the
proposal workflow. Turning on grants later does not convert them into
implementation requests. See [implement a feature](implement-feature.md).

The worker verifies the retained worktree’s identity and Git ownership before
using tools. Replaced or missing worktrees require a fresh task. Tasks created
before 0.6.0 have no saved worktree identity: keep tools disabled to resume their
existing patch workflow, or create a new task to use the new grants.

Use absolute executable paths for command presets and enter each argument
separately. Commands start in the task worktree when one exists, otherwise in the
worker's private model workspace. A working directory is not a sandbox: configured
commands run as the worker's operating-system account and can read or change
anything that account can access. Review commands and their arguments before
enabling them. Output and runtime are bounded, and cancellation stops their
managed process tree.

Web grants use exact origins, including any non-default port, such as
`https://docs.example.com`. A grant covers that origin's paths. Redirects must
remain within granted origins. URLs with embedded credentials are rejected.

## Give the model a project CLI

Use a **CLI tool** when the model needs to pass arguments to a project command,
for example `node bin/harness.mjs backlog context LACF-REQ-012 --format summary`.
Command presets cannot do this; previously, this required a custom stdio MCP
server with its own argument checks.

You fix the executable and the leading arguments. The model supplies the rest,
and each call must pass the tool's argument policy before a process starts:

- **Allowed commands.** The first one or two arguments must match a listed
  command, such as `check` or `backlog context`. Everything else is refused.
- **Required flags.** Add `requires` to a command to allow it only with one of
  the listed flags, for example `backlog set requires --dry-run`. Each supplied
  required flag must stand alone and occur once. Assigned forms such as
  `--dry-run=true`, a corresponding `--no-dry-run` (including assigned forms),
  and short-option clusters containing a required letter are refused. Several
  different listed flags may appear together. A required flag must directly
  follow the command, a value, an `--option=value` argument or another required
  flag; this rejects common cases where a preceding option could consume it.
- **Refused options.** List options that must never be used, such as `--root`,
  `--config` or `--out`, for all commands or with `refuses` for one command. Both
  `--name` and `--name=value` forms are refused. A refused single-letter option
  such as `-o` is also refused inside short-option clusters (`-xo`, `-ofile`).
- **Paths.** Absolute POSIX and Windows paths (`/x`, `C:\x`, `C:x`, `\x`,
  `\\server\share`), `~`, `file:` URLs, `@file` response-file paths and `..`
  segments are refused, including extracted values such as `--out=../file`
  and `-I../folder`. All model-supplied response-file forms are refused,
  including `--args=@file` and `-I@file`. The `--` terminator and control
  characters are refused. These checks apply to model arguments; review the
  operator-configured fixed arguments separately.
- **Bounds.** At most 24 arguments of 500 characters each by default (up to 64
  and 2,048), and 32 KiB of returned output by default (up to 64 KiB).

CLI tools start in the task worktree, without a shell, with the same minimal
environment, configured command deadline and contained process-tree cancellation
as command presets. Shell syntax such as `;`, `|`, `$HOME` or `%PATH%` reaches the
CLI as literal text. The model receives the exit code, stdout and stderr; long
output is cut at the configured limit with a hint about how to narrow the call.
Requests without an approved task worktree have no CLI tools. In **New request**,
use **Repository files · optional** to approve the repository and input paths;
this is separate from granting the CLI tool in Settings. Markdown request
tracking remains automatic with or without these permissions.

To add a CLI tool in **Settings → Tools & MCP → CLI tools**:

1. Select **Add CLI tool**. A new tool starts disabled and uses the Node.js
   executable running the worker; select **Use worker Node.js** to restore it.
2. Enter fixed leading arguments as a JSON array. Relative paths resolve in the
   task worktree, for example `["bin/harness.mjs"]`.
3. List allowed commands, one per line. Describe what the tool does; the model
   reads this text with a generated summary of the policy.
4. List refused options, enable the tool and save.

Example allowed commands for a project harness:

```text
help
check
backlog context
backlog show
backlog set requires --dry-run
codegen requires --check --dry-run
eol refuses --fix --hook
```

The model sees one tool, `werk_cli_<id>`, with the input
`{"args": ["backlog", "context", "LACF-REQ-012", "--format", "summary"]}`. Its
description lists the allowed commands, required flags and refusals. It never
contains the executable path or the fixed arguments.

### Choose commands safely

Choose read-only commands, or require explicit preview/check flags for commands
that can write. A required flag checks argument form, not the CLI's behavior.
The worker cannot know every parser rule or option a CLI accepts, so review the
executable and its argument grammar before granting it. In particular:

- A CLI that accepts abbreviated options (for example Python `argparse`
  defaults, where `--ro` can mean `--root`) can bypass a refused option. Refuse
  the abbreviation too or disable abbreviations in the CLI.
- A CLI that reads paths from configuration files, environment variables or
  symbolic links in the worktree can still reach other folders. A working
  directory is not a sandbox.
- Results reflect the current task worktree, including edits made through the
  candidate tools for an implementation request. In the legacy proposal workflow,
  the proposed patch is not applied, so the CLI does not verify that proposal.
  A CLI tool result does not replace the required feature-check evidence.

Batch files (`.bat`, `.cmd`) cannot be CLI tools because Windows passes their
arguments through `cmd.exe`. Use the interpreter, such as `node.exe`, and pass
the script as a fixed argument.

### Move from command presets or a custom MCP server

Command presets keep working unchanged. To let the model add arguments:

1. Pause and drain the worker.
2. Add a CLI tool with the preset's executable and the part of its arguments
   that selects the program, such as `["bin/harness.mjs"]`.
3. Add the preset's remaining arguments as allowed commands, for example
   `check` for a preset `["bin/harness.mjs", "check"]`.
4. Enable the CLI tool, disable or remove the preset and save.

To replace a hand-written stdio MCP wrapper, copy its allowlist into allowed
commands, its preview-only commands into `requires` rules and its refused
options into the refused list. Then disable the MCP connection and save.

### Configure CLI tools from the portable CLI

`tool-access get` prints the current grants and revision. Edit that output and
send it back with `tool-access set --file`; the revision becomes the save guard.
This command accepts up to 1 MiB from a file or stdin, including exported MCP
catalogs. It removes read-only fields before sending the update; the resulting
write must fit the API's 64 KiB limit. Other JSON commands retain their 64 KiB
input limit. New starts must be paused and the worker idle:

```sh
node bin/apps/worker/cli.mjs queue pause
node bin/apps/worker/cli.mjs tool-access get > tool-access.json
# Edit builtins.cliTools in tool-access.json, then:
node bin/apps/worker/cli.mjs tool-access set --file tool-access.json
node bin/apps/worker/cli.mjs queue resume
```

A minimal CLI tool entry for a Node script in `bin/`:

```json
{
  "id": "harness",
  "name": "Project harness",
  "description": "Reads the project backlog and runs project checks.",
  "enabled": true,
  "executable": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["bin/harness.mjs"],
  "commands": [
    { "command": "help" },
    { "command": "backlog context" },
    { "command": "backlog set", "requireOneOf": ["--dry-run"] },
    { "command": "eol", "refusedOptions": ["--fix"] }
  ],
  "refusedOptions": ["--root", "--config", "--out"],
  "outputKiB": 48,
  "truncationHint": "Narrow the command with --limit or --format summary."
}
```

`description`, `refusedOptions`, `requireOneOf`, `maxArgs`, `maxArgLength`,
`outputKiB` and `truncationHint` are optional. A request file, feature request or
agent definition in the repository cannot add CLI tools. Grants exist only in the
worker's private tool policy.

Before rolling back to 0.9.0, use the current worker version to remove every CLI
tool entry, clear every **Required feature check** mark and save tool access.
Disabling entries alone is insufficient. Reset tool execution limits to 128 calls
and 300 seconds and save duration settings; these defaults and the cleared grants
omit the newer configuration fields. Restore the stopped-state backup from before
the upgrade when retained task state is incompatible, using the
[portable update workflow](../reference/portable-apps.md#update-a-copied-app).

## Connect an MCP server

Add a connection with a recognizable name and choose its transport:

- **Stdio:** an absolute executable path and fixed arguments on the worker
  machine. Configure the server's credential environment variable and secret when
  required. The server runs with the worker account's authority.
- **HTTP:** the server's Streamable HTTP MCP endpoint and an optional bearer
  token. JSON and SSE responses are supported; legacy separate SSE endpoints are
  not. Remote connections require HTTPS; loopback HTTP supports local servers.

Save the connection, then discover its tools. Discovery starts or contacts that
server and reads its catalog; it does not grant the catalog to the model. Review
the tool names and descriptions, select the tools to grant, enable the connection
and save again. Unsupported transports and malformed catalogs return an error
without silently enabling tools.

Treat MCP servers as trusted extensions with their own authority. A tool may
modify external systems even when repository file access is read-only. Tool
descriptions and returned content cannot change the worker's saved permissions.

Secrets are stored privately and never returned to the editor. A blank secret
field preserves a saved value; use the clear control to remove it. Changing the
server destination resets discovery and grants. Rediscovering a changed tool
definition removes its previous grant so you can review it again.

## Revoke access and resolve conflicts

Pause and drain the worker before disabling a grant or connection, removing a
preset, CLI tool or origin, or deleting an MCP connection. Save the change before resuming.
Each invocation captures its tool catalog, and each tool call checks the current
policy revision. A continuation keeps its saved model and instructions but uses
current grants; old dispatch evidence cannot restore a revoked permission.

If another operator saves first, the editor retains your draft and reports a
conflict. Reload the current policy, reconcile your changes and save again.
Locking the webview does not revoke tools or stop work.

Automated request reviewers remain tool-free. For provider requirements and
continuation behavior, see the [model interaction contract](../reference/model-interaction.md).

## Execution limits

Each model invocation can use at most 64 tool definitions. Under **Settings →
Queue & duration → Tool execution limits**, set the maximum calls per attempt
(default 128, range 1–512) and command timeout (default 300 seconds, range
1–3,600 seconds). Calls include file reads, candidate edits and checks. Command
presets, CLI tools and required feature checks share the command timeout.

The existing total invocation limit bounds all model and tool work; there is no
separate two-minute tool window. An invocation keeps its captured budgets even
if settings change while it waits or runs. API providers may return a final
answer after the last permitted tool call. External MCP calls retain a 30-second
deadline and web fetches retain 10 seconds. Cancellation and the remaining total
duration can stop any operation sooner. Timeouts do not automatically retry an
operation, because a command or remote MCP tool may already have changed state.

File reads return at most 32 KiB per call and expose an offset for another chunk.
Web and MCP results are bounded to 64 KiB. CLI tool output is cut at its
configured limit (32 KiB by default, at most 64 KiB); a CLI that writes more than
1 MiB is stopped. Truncated list/search results are
marked incomplete. MCP image, audio and resource content is represented as
text data; the worker does not automatically retrieve resource links.
