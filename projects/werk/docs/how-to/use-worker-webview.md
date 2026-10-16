# Use the worker webview

A worker can run on its own machine without a Factory or orchestrator. From an
extracted release, with Node 24 installed, start it with one command:

```sh
node bin/apps/worker/cli.mjs run
```

Open `http://127.0.0.1:4100`. The release includes the built Vue 3 / Nuxt UI
webview; no npm install or frontend server is needed. State defaults to
`.werk/worker` in the current project. Use `--state-dir /private/worker` and `--port 4201` for
another worker. Keep the process running; Ctrl+C stops it gracefully. Each worker
executes exactly one task at a time, including Chat, explicit file tasks and
remote assignments. For parallel work, start separate workers; see the
[native and Docker examples](assemble-independent-components.md#scale-with-separate-workers).

The worker opens on **Taskboard**, with **History** and **Dashboard** in the
header. The board groups work into Needs you, Running, Up next, Drafts and
Completed. The interaction panel on the right creates tasks or follows up on
the selected task; on narrow screens it follows the board. Dashboard contains
Monitoring & Status. Existing `/chat` bookmarks redirect to `/taskboard` while
preserving task links; `/monitoring-status` redirects to `/dashboard`. Choose **Tour** in the
header for a replayable introduction. Back, Next and Close let you explore at
your own pace; the tour does not send messages, run tasks or change settings.

## Use requests from project files

A worker can also ingest frontmatter-plus-Markdown requests from a watched folder.
[Project setup](project-worker.md) provides the app, configuration, request template
and Docker launch. Requests use the same task sessions and serial execution slot;
frontmatter and adjacent result files expose their lifecycle without the webview.

## Unlock the webview

The dedicated unlock screen protects the workspace until access succeeds. For an
installed project worker, read `WERK_WORKER_TOKEN` in its private project `.env`
and paste it into **Worker access token**. A process environment override takes
precedence. The synchronized `<worker-state>/webview-token` remains the local
credential source for other installations; portable `start`/`status` return its
private file path.
In a system deployment, use
`<system-state>/lines/<line-id>/workers/worker-1/webview-token`.

Unlocking exchanges that token for an HttpOnly, SameSite=Strict browser session.
Reloading the page keeps access for up to 12 hours; choosing **Lock**, restarting
the worker or session expiry requires unlocking again. The operator token is not
stored in the browser, a URL or localStorage. Expired access hides the workspace
and retains an unsent draft in the current tab. A full page reload cannot restore
unsent drafts. Choosing **Lock** explicitly clears the tab’s unsent draft.
Locking the browser does not cancel running tasks.

Basic status, health and metrics remain public. Environment, settings, sessions,
definitions, taskboard and history require worker access. Keep the listener on
loopback or provide a trusted HTTPS access layer that preserves the Host header.
Browsers share cookies across ports of the same host; per-worker cookie names
prevent collisions, not isolation from other services on that hostname. Use
separate trusted hostnames where stronger browser separation is needed. The token
grants operator control of this worker; operators share its tasks and settings.

To rotate access, stop the worker, set a new 64-character lowercase hexadecimal
`WERK_WORKER_TOKEN` in project `.env` or the higher-precedence process environment,
and restart. Startup updates the saved token. If no environment override is used,
removing only `webview-token` while stopped generates a new token on restart.
Deleting that file cannot override a configured environment token. See
[environment configuration](../reference/configuration.md#project-environment-files).

## Connect Claude or Codex

Use **Dashboard → Provider connections & orchestrator enrollment → Connections**.
The task interaction panel links to this editor when a connection needs setup.
Worker access and model sign-in are separate: unlocking the webview never signs
you into a provider. Four connections are supported:

| Connection | Authentication | Configuration |
| --- | --- | --- |
| Codex CLI | Existing Codex CLI login of the worker OS account | Absolute executable path |
| Claude Code CLI | Existing Claude Code CLI login of the worker OS account | Absolute executable path |
| OpenAI API | API key and provider billing | Available model ID and API key |
| Claude API | Anthropic API key and provider billing | Available model ID and API key |

The worker discovers CLI executables on PATH at first startup. Sign in using
`codex login` or `claude auth login` as the same OS account that runs the worker.
Claude Code CLI runs on Linux, macOS and native Windows; the worker discovers
`claude.exe` on PATH. Codex CLI still requires Linux or macOS. API connections and
the webview run everywhere. Use **Check sign-in** after saving a CLI connection. The worker runs only
`codex login status` or `claude auth status`, plus a bounded Claude version
probe. Each subprocess has a five-second deadline. Known Claude versions older
than 2.1.248 require an upgrade; an unknown version is not confirmed compatible. The result distinguishes signed-in, signed-out, unavailable and unknown;
it never exposes raw account diagnostics. No model prompt or paid API call is
made. For API connections, the check confirms saved configuration only: it does
not verify credentials, quota, billing or model availability. There is no automatic
API fallback that could silently change billing.

On native Windows, CLI execution requires Windows PowerShell 5.1, its .NET
Framework runtime, and host policy that permits `Add-Type` and nested Windows
Job Objects. The worker invokes PowerShell from `SystemRoot` without changing
execution policy. Startup uses the worker account’s `PSModulePath`; its module
directories must remain under operator control. The restricted provider
environment is restored before launch. If process containment cannot be established, the provider is
not started. Cancellation closes the supervisor's lifetime job and terminates
its provider processes. On normal provider exit, remaining descendants are
terminated before output is drained and the result is returned.

Use a current Codex CLI supporting `exec --json --ignore-user-config`,
`--ephemeral`, the read-only sandbox and disabled tool feature flags. Claude
Code must support `--safe-mode`, `--restricted`, `--tools`, `--strict-mcp-config`
and `--no-session-persistence` (adapter flags checked against 2.1.296).
CLI Chat starts in a private workspace. All adapters default to tools disabled;
**Dashboard → Tool access** manages explicit built-in grants and MCP connections.
Granted CLI tools use the worker’s private MCP bridge with native tools disabled
and a fresh private working directory. Claude’s tool-enabled path omits
`--safe-mode` because that flag disables MCP; it retains `--restricted`, an empty
native tool list, strict MCP configuration, disabled hooks/plugins/memory and
disabled project instruction loading. The tool-free path retains safe mode.
API calls use the official OpenAI Responses or Anthropic Messages endpoint;
OpenAI responses use `store: false`. Tool results go to the selected provider.
See [manage model tools](manage-model-tools.md) for setup and revocation.

Provider keys and enrollment credentials are saved in the worker's private
`workspace-settings.json`, with mode 0600 on POSIX. They are never returned to
the browser. An empty key field preserves an existing key; use **Remove saved
API key** to clear it. Stop active replies and finish or cancel queued local
tasks before changing provider settings. Settings apply without reinstalling. Editing controls are disabled while saving.
If another operator changes settings, untouched forms update automatically;
unsaved edits are retained with a notice and **Reload** action. Connection checks
require saving edits first.

Legacy `chat.codexExecutable` in worker JSON or native system YAML remains a
first-start seed. Persisted webview settings take precedence on later starts.
Orchestrator task profiles are edited separately under **Execution profiles**:
connecting a chat/API provider does not change the worker’s orchestration mode
or advertised profiles.

## Create and follow up on a task

Choose **New task** in the task interaction panel, select a connection and enter
the outcome under **Task instructions**. **Create task** creates its session and
queues the first message together. Expand **Agent definition** to choose an
imported definition/agent or an optional task name. See
[agent definition profiles](../reference/agent-definitions.md) for compatibility
and instructions-only adaptation. If creation succeeds but message delivery
cannot be confirmed, the task keeps its instructions for review before retrying.

Select a board card to open **Follow up** for that task. The transcript, saved
model evidence and composer remain scoped to the selection. Use **New task** for
unrelated work. Additional tasks wait while the worker is occupied or new starts
are paused. The Running strip identifies the recorded active attempt and its
model when evidence is available; a configured default is not shown as proof of
the model used. **Stop task** targets that verified local execution. Upstream
assignments retain their orchestrator controls, and reviewer runs open the
request review controls.

Every explicit local file task and remote orchestrator assignment also has a
dedicated session. Sessions retain their transcript and provider affinity across
restarts and are shared by this worker's operators. Select an existing task
session to inspect its transcript. Session management supports naming and
retention; creating or selecting a session does not grant extra execution slots.
The worker supplies saved successful turns to its model calls. It does not import
host CLI sessions or transfer native session identifiers between providers.
Changing selection in another tab makes stale send/stop requests fail rather
than target the wrong session.

Use **Board** or **List**, search by title or identity, and select a card to
focus its conversation. Drafts and completed work remain available in their
own disclosures. Completed model replies render Markdown as readable headings,
paragraphs, nested lists, quotations, links, tables and code blocks. Code blocks
keep their original text and offer **Copy code**; wide code and tables scroll
within the reply on smaller screens. Saved replies use the same formatting.
File paths and globs such as `src/**/*.spec.ts` in a reply stay literal instead
of turning into bold or italic text. A saved protocol reply, such as a question
checkpoint or a file-task change set from an older worker, appears as readable
text; its stored form stays available under **Raw model output**.
Your messages and failure notices remain literal text. Model HTML is never
executed, and images appear as descriptive links rather than loading automatically.
You can draft a follow-up while work is queued or running and send it when the
worker finishes. Use the composer or Ctrl/Command + Enter to submit a message. The stop action
cancels the pending or active reply. Each provider invocation uses the worker’s
configured execution limit: six hours by default, configurable from one second
to 24 hours. `WERK_WORKER_MAX_RUNTIME_MS` overrides saved settings. The limit
starts when execution begins; queue waiting is separate. Sessions hold at most 60 messages with
a 48,000-character input budget; user messages are limited to 8,000 characters
and replies to 32,000. Up to 100 task sessions are retained. Deleting a task session
requires confirmation; New task preserves the previous transcript. A failed save
is shown as unsaved. Interrupted requests
are marked explicitly after restart rather than silently replayed.

Only the worker prompts the model. A Chat task does not automatically expose
dashboard telemetry or repository files. Use the file-task editor below to
approve file input and generate a patch. Repository file tools additionally
require an explicit grant and an approved task worktree; commands, web access
and MCP tools follow their separately saved grants.

## Assign and watch repositories

An unassigned Git checkout in the worker’s project folder appears on unlocked
Taskboard as **Use this Git repository?**. Review the full checkout path, branch
and remote. **Use repository** saves an assignment and enables safe watching when
a branch and remote exist. Without either, watching stays off and committed file
tasks can still use worktrees. Finish queued/running work before accepting.

**Don’t use** saves a decline and removes the Taskboard prompt. It does not block
Chat or unrelated work. Revisit the choice in **Dashboard → Git repositories →
Use the repository you skipped?**. Until accepted or explicitly assigned, the
detected checkout is not fetched, pulled or used for task worktrees. The worker
does not automatically select a parent directory’s repository. Choices survive
restart; replacing the repository requires a fresh choice.

In Dashboard, open **Git repositories → Manage repository assignments** to assign
existing Git checkouts to this worker.
Choose stable IDs and paths on the worker machine, then configure the remote,
optional branch and watching. Finish queued/running work before changing the list.
Repository status reports fetched commits and conditions that prevent a safe
fast-forward. **Check & pull** refreshes an assignment without waiting for the
polling interval. Use **Save assignments** to persist edits. Dirty changes and
local/divergent commits are preserved.

Each assigned coding task receives a detached worktree beneath the selected repository's
`.werk/worktrees` directory. Worktrees are retained across restart. See
[repository configuration](../reference/configuration.md#assigned-git-repositories)
for startup seeds, saved-setting precedence, polling and cleanup.

## Run local coding tasks

Choose **New task → Prepare a file task** in the interaction panel. The file editor has its own draft; edit its instructions and choose its provider connection. Give it a title, a
repository from the assigned list, and an explicit list of relative file paths.
The worker captures those files from a pinned worktree when accepting the task.
When no repositories are assigned, the absolute-directory input remains available.
Git roots use worktrees; the detected project checkout still requires the saved
consent above. Legacy non-Git directories retain bounded snapshot-only behavior
without Git provenance.
Switching task selection does not change this editor’s instructions or provider. Successful submission keeps the separate conversation draft. Access expiry retains the file editor in this tab; explicit Lock clears it.

Only those snapshots and your instruction are sent to the chosen provider in
the new file task's dedicated session. The preceding Chat transcript is not
included in its task input. File tasks use the same single execution slot as
Chat and remote assignments.

Local tasks are bounded file-change generation: up to 32 approved text files,
24 KiB per input file and 48,000 input characters in total. New files are
supported. Secret-like paths, symlinks and path traversal are rejected. The
provider returns complete changed file contents; the worker validates them and
creates a unified patch. It never executes model-generated shell commands.
Your source checkout remains unchanged by the file task, and tests are **not** run
automatically. The retained worktree contains its captured input; changed file
contents remain in the review patch. Ordinary provider Chat still has no arbitrary
filesystem or shell tools.

In **History → File tasks**, choose **Review patch**, inspect the result and
choose **Download patch**. **Open conversation** opens its dedicated transcript.
The transcript shows the model's summary and the changed files with added and
removed line counts, never the full file contents; **Review proposed patch**
under the latest reply opens the patch.
A failed evidence read offers Retry without removing the task list.
Review it, then check and apply it from the repository:

```sh
git apply --check /path/to/download.patch
git apply /path/to/download.patch
```

Run your project's tests after applying. Patches use captured input, so a changed
checkout may no longer accept a patch. **Retry saved input** retains the original
snapshots; start a new task to capture current files. Terminal results are saved
locally, with review artifacts under `local-review/`.

## Configure the taskboard and orchestrator queue

History lists conversations from chat, file tasks and orchestrator assignments.
Search by title, ID or provider, filter task type and state, or choose archived
tasks to **Restore and open** a conversation. File tasks also appear in Queued,
Running, and Review & finished columns with their own search and state filter. Inspect file tasks
to stop, change queued priority, retry failed work, archive or delete. The file
taskboard retains at most 100 tasks. Configure:

- **Local task capacity:** 1–64 accepted local tasks, counting queued and running
  work. This limits the queue, not execution concurrency.
- **Extra orchestrator queue places:** 0–64 accepted assignments beyond the one
  worker execution slot; defaults to zero.
- **Start order:** FIFO or high priority first for queued file tasks.

There is always exactly one executing task across Chat, explicit file tasks and
orchestrator assignments. With two extra orchestrator queue places, a worker can
accept three remote assignments, but still executes only one task in total.
Waiting assignments have lease renewal; loss of ownership prevents execution.
The orchestrator remains the authority for assigned tasks. Its task state calls
leased assignments `running`, while the worker distinguishes queued from
executing. Both services must support the queue extension to enable extra places.

**Pause queue** in Dashboard or History holds all new execution starts, including Chat, file tasks and
already accepted remote assignments. The active task can finish; waiting work
remains queued until resumed. Pausing display updates in the header is separate:
it only pauses refresh of the webview. Reducing queue limits does not discard
accepted work. To execute more tasks in parallel, run more worker instances
with separate state and ports; there are no independent chat or local-task
process budgets that bypass the worker's single execution slot.

Queued file tasks survive restart. Interrupted file execution becomes failed and
requires an explicit retry. Orchestrator assignments are reconciled from the
server and existing terminal evidence is not executed again.

## Connect an orchestrator later

In **Dashboard → Provider connections & orchestrator enrollment**, enter its HTTP(S) origin and enrollment token, then
choose **Save & connect**. The worker registers automatically and retries when
unavailable; the webview, sessions and local taskboard remain available. Initial
CLI enrollment also works with `--url` and `WERK_ENROLLMENT_TOKEN`.

Registration supplies the worker's configured execution profiles and policy.
Existing default profiles are simulations; real orchestrator execution remains
the explicitly configured native Linux Codex adapter described in
[Run a Codex task](run-codex-task.md). Local API/Claude patch tasks are separate
from that established orchestration contract.

Complete accepted assignments before choosing **Go standalone**. Pause holds
queued assignments as well as new work; if assignments are waiting, resume them
to finish first. Once no assignments remain, pause the queue and disconnect. Identity and evidence are retained for reconnecting to
the same orchestrator. Switching a registered identity to a different server
requires a separate worker state directory to preserve assignment ownership.

For independent launch commands, private service credentials and subsequent
Factory registration, see [Assemble independent components](assemble-independent-components.md).

## Edit execution profiles

Open **Dashboard → Execution profiles**. These are the IDs/providers offered for
orchestrator assignments, separate from provider sign-in, model settings and
imported agent definitions. A simulated worker supports 1–8 Claude/Codex profiles;
a worker already configured for native Linux Codex supports one Codex profile.
Editing keeps the current execution mode and the shared single execution slot.

1. Finish or stop queued/running tasks and active replies, then **Pause new starts**.
   Pausing leaves queued work in place; resume to finish it or stop it before editing.
2. Edit **Profile ID** and **Provider**, using **Add profile** or **Remove** where
   available. IDs must be unique; changing an ID changes its routing name.
3. Choose **Save profiles**. Before first registration, the change takes effect
   immediately. A registered worker shows **Waiting for the orchestrator** until
   the same orchestrator accepts the update; the old profiles remain active.
4. Once the update is accepted, resume from **Work in progress** when ready.

Offline changes are saved and retried automatically. While pending, new local and
remote work, queue resume and further profile edits are blocked. Restart preserves
the pending change; **Go standalone** does not bypass its required acknowledgment.
Reconnect to the same orchestrator to complete it. An older orchestrator without
profile updates must be upgraded before acceptance can succeed.

If the save response is uncertain, use **Check saved profiles** or **Retry same
save**. If another operator changed profiles, your draft stays visible; use
**Discard edits and reload** before making a new change. Worker identity, sessions
and task history are preserved. See the [profile contract](../reference/configuration.md#editable-execution-profiles)
for API fields and private-state persistence.

## Interact from a line or orchestrator dashboard

The line dashboard inside Factory and the independent orchestrator offer an
**Interaktion öffnen** widget. Its Chat tab connects to a worker already
registered with that line. Enter the worker webview address reachable from the
orchestrator and its access token. The widget uses the worker's selected task
session and shares its transcript with the worker webview. New task followed by
its first message queues a task on that worker; subsequent messages continue
the same session and share its single execution slot. Configure providers
and manage sessions in the worker itself. If another operator changes the
selected session, reconnect before sending more messages.

The worker token stays in dialog memory and is passed through authenticated
service requests; it is not saved in URLs or browser storage. Close clears the
widget connection, but does not delete the worker-owned task session. The widget
forwards requests; only the worker prompts an LLM.

Use the separate **Submit task** tab when work should enter the line's configured
router. Supply a requirement link or title and acceptance criteria. That router
chooses an eligible worker independently of the widget's connected worker.
This differs from New task/Chat, which queues work directly on the connected
worker, and from **Run task**, which explicitly captures approved files for a
review patch. All three paths execute serially on whichever worker owns them.

## Inspect history and Dashboard

History also exposes **Project requests** from the configured feature folder and
**Execution evidence** for local Chat/file/feature executions. Inspect the current
request state, paired run observations and provider-reported consumption; use
filters, aggregate coverage and export to compare many runs. Missing usage is
unknown, not zero. See the [run metrics contract](../reference/worker-run-metrics.md)
and [complete worker lifecycle](../tutorials/worker-feature-lifecycle.md).

Below the taskboard, History shows retained orchestrator before/after snapshots.
Search and filter attempts, inspect evidence and download local task patches.
A simulated attempt is never presented as implemented code. Missing or unreadable
evidence remains explicit. Snapshot history follows retention; the reader
inspects at most 1,000 directories and discloses when this is only a sample.
New task titles are kept in a bounded private index.

Dashboard starts with current work and queue controls. **Open running task**
opens its conversation; **Review patches** and **Failed tasks** open filtered
History results. Health and host memory/disk remain visible. Open the named
disclosures for the connection map, orchestrator slots, delivery backlog, profiles,
worker RSS/heap, load, CPUs, OS, Node version, paths and diagnostics.
Standalone mode is healthy without an orchestrator. Node RSS excludes provider
subprocesses; container host readings are not quota guarantees. Usage, cost,
subscription balance and login status remain unknown unless actually measured.

**Dashboard → Consumption limits** sets this worker's share of a configured
daily or monthly token allowance. It shows measured usage, reservations,
remaining tokens and the next UTC reset. Limits start disabled. When enabled,
insufficient budget holds new model calls while accepted work stays queued;
personal use outside the worker remains unmeasured. Follow
[set a worker consumption limit](worker-consumption-limits.md) for setup and
recovery from incomplete usage.

Pages refresh every three seconds while visible; header controls pause readings
or refresh manually. Failed reads retain the last observation with a stale-data
warning; successful reads still update independently. A successful action remains
accepted if its follow-up refresh fails, avoiding a misleading retry prompt.
No environment-variable values or credentials are shown.

## Answer a question or continue after interruption

The taskboard places a pending question or escalation in **Needs you** and opens its answer controls in **Follow up**.
Read its reason/choices, enter your response and submit through the pending-input
control. Generic follow-up sending is held until that decision is resolved.
History and Dashboard identify requests needing input and link back to the selected task on the taskboard.

Inspect the saved checkpoint before resuming a failed, cancelled or interrupted
turn. Continuation replays saved context in a fresh invocation and may consume
additional tokens. Restart alone does not repeat ambiguous work. Latest-turn
consumption shows measured values and unavailable fields; a reported estimate is
not a billed amount. See [answer and resume](answer-and-resume-worker.md) for the
equivalent human/agent CLI workflow and stable operation-key rules.
