# Manage model tools from the worker

Open **Dashboard → Tool access** in the unlocked worker webview. Its setup
shortcut opens the editor directly. Tool access is separate from provider sign-in,
execution profiles and agent definitions. All grants start disabled, including
after upgrading an existing worker.

Grants apply to local Chat and approved-file tasks using the worker's configured
model connections. Results from granted tools are sent to the task's selected
model provider. Grant only the content and operations that provider may receive.
The separate orchestrator execution adapter retains its own execution policy;
these controls do not change simulated tasks into live executions.

## Grant built-in tools

Pause new starts, then finish or cancel queued and running work. Open **Tool
access**, edit the grants and save. Resume new starts when the saved policy is
correct. Saving requires the worker to be paused and idle so an active invocation
cannot retain a grant that appears revoked in the editor.

| Grant | What the model can do |
| --- | --- |
| Repository files | List, read and search files in an approved task's Git worktree. Chat without a task worktree has no repository file tools. |
| Command presets | Run the exact executable and arguments you configure. The model chooses a preset; it cannot supply an arbitrary shell command. |
| Web origins | Fetch HTTP(S) content from the origins you allow. This is page fetching, not a search-engine connection. |

File tools are read-only. They exclude Git metadata, reject path escapes and
symlinks, and bound returned content. Approved-file tasks still return a patch
for review; enabling file tools does not apply that patch to the checkout.

The worker verifies the retained worktree’s identity and Git ownership before
using tools. Replaced or missing worktrees require a fresh task. Tasks created
before 0.6.0 have no saved worktree identity: keep tools disabled to resume their
existing patch workflow, or create a new task to use the new grants.

Use absolute executable paths for command presets and enter each argument
separately. Commands start in the task worktree when one exists, otherwise in the
worker's private Chat workspace. A working directory is not a sandbox: configured
commands run as the worker's operating-system account and can read or change
anything that account can access. Review commands and their arguments before
enabling them. Output and runtime are bounded, and cancellation stops their
managed process tree.

Web grants use exact origins, including any non-default port, such as
`https://docs.example.com`. A grant covers that origin's paths. Redirects must
remain within granted origins. URLs with embedded credentials are rejected.

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
preset or origin, or deleting an MCP connection. Save the change before resuming.
Each invocation captures its tool catalog, and each tool call checks the current
policy revision. A continuation keeps its saved model and instructions but uses
current grants; old dispatch evidence cannot restore a revoked permission.

If another operator saves first, the editor retains your draft and reports a
conflict. Reload the current policy, reconcile your changes and save again.
Locking the webview does not revoke tools or stop work.

Automated request reviewers remain tool-free. For provider requirements and
continuation behavior, see the [model interaction contract](../reference/model-interaction.md).

## Execution limits

Each model invocation can use at most 64 tool definitions and make 32 calls.
Tools share a two-minute window beginning with the first call. Each command or
MCP call has a 30-second deadline; web fetches have a 10-second deadline. The
worker invocation limit still applies. Timeouts do not automatically retry an
operation, because a command or remote MCP tool may already have changed state.

### When the tool budget runs out

The model is told before and when its tools run out:

- Once 8 or fewer calls, or 30 or fewer seconds of the window, remain, each tool
  result ends with a note such as
  `Tool budget: 5 of 32 calls and 38 s of the 120 s tool window remain.`
- A call after the budget is used runs nothing and returns a tool error that
  starts with `Tool budget exhausted` and tells the model to finish with what it
  has or ask you a question. A call still running when the window ends is stopped
  with the same kind of error.

To check whether a task's results are incomplete because of the budget, open the
task: **Tool budget exhausted** appears next to the latest turn's consumption with
the reason, calls used, the window and the number of refused calls. Integrations
can read the `tool_budget_exhausted` interaction event or the turn's `toolBudget`
field; see the [tool budget reference](../reference/model-interaction.md#tool-budget).
If a task regularly hits the budget, split it into smaller tasks or narrow the
granted tools so the model needs fewer calls.

File reads return at most 32 KiB per call and expose an offset for another chunk.
Web and MCP results are bounded to 64 KiB. Truncated list/search results are
marked incomplete. MCP image, audio and resource content is represented as
text data; the worker does not automatically retrieve resource links.
