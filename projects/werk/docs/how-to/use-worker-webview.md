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
executes one attempt at a time for its Feature Requests, including conversations,
approved-file implementations and remote assignments. For parallel work, start
separate workers; see the
[native and Docker examples](assemble-independent-components.md#scale-with-separate-workers).

Four primary pages organize the workspace; a request opens its own review page:

| Page | Use it to |
| --- | --- |
| Taskboard · `/taskboard` | Give instructions, follow current work and answer questions. |
| Metrics · `/dashboard` | Inspect consumption, execution evidence and worker health. |
| History · `/history` | Find saved tasks and retained execution evidence. |
| Feature Request review · `/review?session=…` | Inspect one request’s accepted goal, changes, checks, decision and handoff. |
| Settings · `/settings` | Configure providers, queues, tools, repositories and intake. |

Taskboard opens after unlock. Its interaction panel sits beside the board on wide
screens and follows it on narrow screens. Existing `/chat` bookmarks preserve task
links; `/monitoring-status` opens Metrics. Earlier Dashboard setup anchors redirect
to Settings. Choose **Tour** for a replayable introduction; it does not submit
work or change configuration.

## Use requests from project files

The Feature Request is the central workflow entity. The webview and Markdown
notes are ways to create, inspect and respond to it; sessions, attempts, questions
and review notes belong to that request. [Project setup](project-worker.md) provides
the app, configuration, request template and Docker launch. A shared repository
uses [shared Git intake](shared-feature-intake.md) for requests from either interface.
Private workers without that binding retain local intake and the same serial
execution slot.

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

<a id="connect-claude-or-codex"></a>

## Connect Claude, Codex or Cursor

Use **Settings → Providers & accounts**.
The task interaction panel links to this editor when a connection needs setup.
Worker access and model sign-in are separate: unlocking the webview never signs
you into a provider. Five connections are supported:

| Connection | Authentication | Configuration |
| --- | --- | --- |
| Codex CLI | Existing Codex CLI login of the worker OS account | Absolute executable path |
| Claude Code CLI | Existing Claude Code CLI login of the worker OS account | Absolute executable path |
| Cursor CLI | Cursor account login or private Cursor API key | Absolute `agent` executable path; native Cursor permissions/hooks |
| OpenAI API | API key and provider billing | Available model ID and API key |
| Claude API | Anthropic API key and provider billing | Available model ID and API key |

The worker discovers CLI executables on PATH at first startup. Sign in using
`codex login` or `claude auth login` as the same OS account that runs the worker.
Claude Code CLI runs on Linux, macOS and native Windows; the worker discovers
`claude.exe` on PATH. Codex CLI still requires Linux or macOS. API connections and
the webview run everywhere. Use **Check sign-in** after saving a CLI connection.
For Codex and Claude, the worker runs only `codex login status` or
`claude auth status`, plus a bounded Claude version probe. Each subprocess has a
15-second deadline, and a failed login probe is retried once. Known Claude versions older
than 2.1.257 require an upgrade for durable sessions; an unknown version is not
confirmed compatible. The result distinguishes signed-in, signed-out, unavailable and unknown;
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
and explicit `--session-id`/`--resume` continuation (adapter flags checked against 2.1.296).
Durable sessions refresh the worker’s current instructions and tool grants; legacy
one-shot calls retain `--no-session-persistence`.
CLI Chat starts in a private workspace. Codex, Claude Code and direct API adapters
default to tools disabled; **Settings → Tools & MCP** manages their explicit
built-in grants and MCP connections. Cursor uses the native policy described
below. Granted Codex/Claude CLI tools use the worker’s private MCP bridge with native tools disabled
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

### Connect Cursor CLI

Install a current [Cursor CLI](https://cursor.com/docs/cli/installation) on the
worker machine. Werk discovers `agent` on PATH (`agent.exe` on Windows); you may
also configure the absolute path to a legacy `cursor-agent` installation. No
minimum version is assumed from an unknown version result.

Authenticate as the OS account that runs the worker:

```sh
agent login
agent status
agent models
```

For Cursor API billing, explicitly select `api-key` and save the Cursor key in
the private provider editor. Werk passes that selected key privately to the
subprocess. Account mode uses the supported CLI login and excludes API-key
fallback. Keep credentials out of request notes and command arguments. Project
`.env` files contain only their documented Werk launch keys. See [Cursor authentication](https://cursor.com/docs/cli/reference/authentication).

Select **Cursor CLI** in **Settings → Providers & accounts**, save its executable,
default model and optional key, then use **Check sign-in**. The bounded status and
version probes do not prompt a model. **Account on the worker machine** displays
recognized identity information; it does not establish subscription quota or remaining usage.
Choose a model listed for your account; Cursor exposes model selection through
its [CLI parameters](https://cursor.com/docs/cli/reference/parameters).

Cursor's native tools, hooks, MCP connections and subagents follow the operator's
Cursor configuration. Review [Cursor permissions](https://cursor.com/docs/cli/reference/permissions)
and [hooks](https://cursor.com/docs/hooks) for the account and execution workspace.
Werk does not add force, automatic MCP approval, workspace-trust or sandbox
bypass flags. Its **Tools & MCP** grants constrain supplemental Werk tools only;
they do not restrict Cursor's native tools or hooks.

Chat and Ready Check use Cursor's read-only **ask** mode in a private worker
workspace. This is Cursor behavior, not a Werk no-tools isolation guarantee.
Implementation uses the worker's pinned candidate worktree; Werk validates the
result and runs required verification after Cursor returns. Native command output
alone does not establish a passing check. See the
[Cursor execution boundary](../reference/model-interaction.md#cursor-native-execution).

Cursor supports **Provider default** effort only. Token and cost counters,
including native subagent usage, are unavailable in this adapter. Metrics show
unknown usage; an enabled consumption limiter can hold subsequent work until
unverified usage is resolved through the existing controls. An account login or
successful reply does not establish a remaining allowance.

### Choose authentication explicitly

Each provider connection records its authentication/billing mode. Use
`cli-account` for the supported official CLI login or `api-key` with a privately
saved key. API adapters accept `api-key` only. Existing connections marked
`legacy` require an explicit selection before new dispatch. A failed account
connection does not fall back to an environment or saved API key.

Read the runtime/version, connection result and capability diagnostics before
submitting work. A supported interface can still lack isolation, interactive
approval or detailed usage; the UI reports those limits. A successful diagnostic
is not a successful model invocation or proof of available quota.

For the Windows/Claude pilot, run this read-only preflight from the source checkout
with the actual installed executable path:

```powershell
node scripts/runtime/provider-diagnostics.mjs --provider claude-cli --executable "C:\path\to\claude.exe" --authentication-mode cli-account
```

It emits sanitized environment/runtime/capability information and
`liveInferenceQualified: false`. Complete the disposable-repository implementation,
verification, interruption and review journey before claiming native qualification;
see the [acceptance ledger](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reports/2026-10-20-local-delivery-acceptance.md).

## Choose provider, model and effort

In **Settings → Providers & accounts**, save **Default provider for new requests**
to choose the connection offered for new intake. Each connection also has
**Default model** and **Default effort**. Save the connection after changing
those defaults. Existing provider-save restrictions still apply while work is
queued or running.

In **New request → Task options**, or **Request options** for a shared draft,
choose **Provider**, an optional **Model**, and **Effort**. A reopened shared draft
exposes the same selection in its request details. Leave Model blank to use a
compatible instruction-profile model, then the selected provider's default.
Choose **Inherit worker default** for effort inheritance, or **Provider default**
to request the provider's own behavior explicitly. Cursor CLI supports only
Provider default effort; other choices depend on the selected provider and model.

The worker freezes the effective selection when it accepts the Feature Request.
New defaults do not alter an owned request's Ready Check, implementation, answers
or resumed session. Use a successor request to change that execution selection.
The [selection contract](../reference/model-interaction.md#provider-model-and-effort-selection)
lists precedence, allowed values and the distinction between a configured model
and an observed provider model.

## Create and follow up on a task

For a connected shared repository, **New request** starts in the chat interaction
panel and creates the same project Feature Request as the team's authoring skill:

1. Describe the outcome under **Request instructions**. **Request options** lets
   you choose a provider, optional model and effort, name the request and list
   approved file paths.
2. Choose **Prepare request**. This loads the committed project template and
   places your instructions in the draft; it does not invoke a model or start work.
3. Complete **Goal**, **Context**, **Acceptance criteria**, **Verification plan**
   and approved paths. Use **Advanced template editing** for custom template
   sections, then **Check readiness** against the project's configured rules.
4. Choose **Save draft to Git** to share unfinished work, or **Mark ready and
   publish** after readiness passes. Both actions commit and push the note to the
   displayed shared branch. Only the ready request is eligible for execution.
5. Open its conversation once this worker owns it. Progress, evidence and Task
   answers remain attached to that Feature Request. Other teammates can pull and
   inspect the same note from their clones.

Published drafts can be reopened under **Shared requests**. Unpublished edits stay
in the current tab until reload or lock. A changed remote request, template or
binding requires fresh inspection; the worker does not overwrite it silently.
**Retry same request** retains an unconfirmed publication's exact command and
identity. Do not start another request to recover that publication.

Shared intake owns execution admission, remote claims and lifecycle publication;
accepted work uses the existing queue. Disabling **Accept new shared requests** pauses new claims; it does
not switch this project to direct chat execution. Ready requests wait for intake,
capacity and consumption limits to permit a start.

For a worker without a shared repository binding, choose **New request** and
describe the outcome under **Request instructions**.
**Task options** shows the selected provider and lets you change it, name the task
or choose an imported definition/agent. Without an explicit name, the first
message supplies the title. **Create request** creates the task and starts its
automatic Markdown tracking. **Repository files · optional** lets you approve
bounded file input and patch generation in the same interaction; leaving it off
does not disable the feature-request record. See
[agent definition profiles](../reference/agent-definitions.md) for compatibility
and instructions-only adaptation. If creation cannot be confirmed, **Retry same
request** resends the exact saved command and identity. Keep that request intact
until its outcome is known; it cannot create a second admission when replayed.

Select a board card to open **Follow up** for that request. The transcript and
saved model evidence remain scoped to the selection. For a shared request, use
its answer or resume controls when the worker needs input: submitting publishes
the linked Task response to Git, and the same Markdown response consumer resumes
the existing request. Additional scope requires a new Feature Request; accepted
requirements stay frozen. Private local requests retain a free-form follow-up
composer. Use **New request** for unrelated work. Additional tasks wait while the worker is occupied or new starts
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
In completed model replies, file paths and globs such as `src/**/*.spec.ts`
stay literal instead of turning into bold or italic text. A validated checkpoint
in a retained file task, or a change set in a retained proposal task, appears as readable text; its stored form stays under **Raw model
output**. Older stored text may be shortened. This display does not create a
pending question or certify that the current saved patch matches an older reply.
Ordinary JSON examples remain code blocks; they do not imply a saved patch or
an active checkpoint.
Your messages and failure notices remain literal text. Model HTML is never
executed, and images appear as descriptive links rather than loading automatically.
For private local requests, you can draft a follow-up while work is queued or
running and send it when the worker finishes. Use the composer or Ctrl/Command + Enter to submit a message. The stop action
cancels the pending or active reply. Each provider invocation uses the worker’s
configured execution limit: six hours by default, configurable from one second
to 24 hours. `WERK_WORKER_MAX_RUNTIME_MS` overrides saved settings. The limit
starts when execution begins; queue waiting is separate. Sessions hold at most 60 messages with
a 48,000-character input budget; user messages are limited to 8,000 characters
and replies to 32,000. Up to 100 task sessions are retained. Deleting a task session
requires confirmation; New request preserves the previous transcript. A failed save
is shown as unsaved. Interrupted requests
are marked explicitly after restart rather than silently replayed.

Only the worker prompts the model. Instructions alone do not grant repository
access. Use the optional repository-file approval below when a request needs
captured inputs and a review patch. Repository file tools additionally require
a worker grant and an approved task worktree; commands, web access and MCP tools
follow their separately saved grants.

## Inspect the feature-request record

Every request has automatic Markdown tracking, including work created without
repository-file permission. Follow-ups, answers and retries retain its Feature
Request identity. Where an intake note already exists, generated tracking is a
FeatureRequestProgress projection of that source request, not another intake item.
The selected task's **Feature request Markdown** section shows the
confirmed filename, recorded state and last saved time, with readable content
and **Download Markdown**. **Refresh request record** retries a read/sync check.

For a configured feature folder, records live in its `_tasks/` subfolder.
Workers without a configured feature folder use `<stateDir>/feature-requests/`. Source requests remain
separate and authoritative for intake; editing a generated progress record does
not submit work, answer a question or approve a result. Execution completion,
request gates and human review remain distinct.

A saving message or synchronization error means the latest progress may not yet
be reflected in Markdown. Accepted work remains in the durable worker journals;
do not create a duplicate request to recover a record write. The worker retries
synchronization. See the [tracking contract](../reference/feature-requests.md#automatic-task-tracking).

## Assign and watch repositories

An unassigned Git checkout in the worker’s project folder appears on unlocked
Taskboard as **Use this Git repository?**. Review the full checkout path, branch
and remote. **Use repository** saves an assignment and enables safe watching when
a branch and remote exist. Without either, watching stays off and committed file
tasks can still use worktrees. Finish queued/running work before accepting.

**Don’t use** saves a decline and removes the Taskboard prompt. It does not block
Chat or unrelated work. Revisit the choice in **Settings → Repositories →
Use the repository you skipped?**. Until accepted or explicitly assigned, the
detected checkout is not fetched, pulled or used for task worktrees. The worker
does not automatically select a parent directory’s repository. Choices survive
restart; replacing the repository requires a fresh choice.

In **Settings → Repositories**, open **Manage repository assignments** to assign
existing Git checkouts to this worker.
Choose stable IDs and paths on the worker machine, then configure the remote,
optional branch and watching. Finish queued/running work before changing the list.
Repository status reports fetched commits and conditions that prevent a safe
fast-forward. **Check & pull** refreshes an assignment without waiting for the
polling interval. Use **Save assignments** to persist edits. Dirty changes and
local/divergent commits are preserved.

Each assigned coding task receives a detached worktree beneath the selected repository's
`.werk/worktrees` directory, or beneath **Task worktree folder** when set to an
absolute folder outside the checkouts. Worktrees are retained across restart. See
[repository configuration](../reference/configuration.md#assigned-git-repositories)
for startup seeds, saved-setting precedence, polling and cleanup.

## Run local coding tasks

The controls below apply to private workers without a shared repository binding.
For a shared project, approve paths in the Feature Request draft above and publish
it through the shared queue. Both use the existing approved-file executor.

In **New request**, keep your instructions in the same composer and expand
**Repository files · optional**. Enable **Allow changes to approved repository
files**, choose an assigned repository and list the relative paths the request
may use. Provider, task name and agent choices remain in Task options. Submit
with **Create request**; the same request retains its instructions and tracking.

**Create request** keeps your original instructions and request identity while
showing background preparation progress. This progress is not yet confirmation
that a task or Markdown record was saved. The composer waits for the admitted
session before showing its task and tracking state. A failed or unconfirmed
preparation retains your instructions and offers **Retry same request**; status
polling never submits the request again. The task board also shows preparation
progress and lets you dismiss a failed entry.

Deleting an admitted task removes its worktree when it is clean and its ownership
is verified; clear the confirmation checkbox to retain it. Changed, locked or
otherwise protected worktrees remain available for inspection.

The worker captures approved files from a pinned worktree when accepting the
request. When no repositories are assigned, the absolute-directory input remains
available. Git roots require the saved consent above. Legacy non-Git directories
retain bounded snapshots without Git provenance. The preceding conversation is
not copied into a new request's approved-file input.

After interrupted preparation, **Retry same request** can reuse only a worker-owned,
unchanged worktree bound to the original request. If that checkout changed or
cannot be proven unchanged, the worker preserves its files and saves a failed
task with a Markdown record; no file snapshots were accepted. Inspect the retained
worktree path, then use **New request** to approve current repository files.
The failed request cannot resume, retry execution or accept follow-ups. Repeating
its original creation returns that same failed record without executing it.

The file-change path supports up to 32 approved paths. Exact-file input snapshots
are limited to 24,000 bytes per file and 48,000 characters in total. Implementation
requests can also approve folders ending in `/`; the model reads their files
through granted tools rather than initial content snapshots. Candidate content
and patch limits are separately configurable; see
[implementation limits](implement-feature.md#current-limits). New files are
supported; secret-like paths, symlinks and path traversal are rejected. For a new Git-backed request with file
access and at least one enabled **Required feature check** preset, the model can
edit approved files in the worktree, run checks and repair failures. The worker
generates the patch from the actual candidate and requires every frozen check to
pass on that candidate. Inspect **Implementation evidence** in the selected task
or History.

Other requests retain the proposal-only workflow: validated returned contents
become a patch without being applied or automatically tested. The composer
explains available setup; the saved task records its accepted mode. Commands and
MCP tools retain their separate saved grants. All work shares configured machine
capacity; project limits can be stricter, and unscoped work remains exclusive.
See [implement a feature](implement-feature.md) for setup and review.

Choose **Review changes** or **Review result** on a request card to open its
Feature Request review page. Its deep link preserves the exact request without
selecting a different chat. Work through the accepted goal, changed files,
verification, decision and shared handoff in that order. The next-action card
explains what is currently required.

The file navigator shows added/removed lines and line numbers. Large or malformed
patches have explicitly bounded previews; **Download full patch** retains the
complete saved bytes. Markdown summaries and criteria remain readable. Required
checks show whether their evidence belongs to the current candidate; unavailable,
failed and outdated checks never imply successful implementation.

Local delivery requires human acceptance. Inspect the current candidate and
record the required manual criterion outcomes with supporting notes before
accepting. The decision identifies the request input revision and candidate Git
commit; changing requirements, code, baseline or check definitions requires fresh
evidence. A legacy request may additionally expose its configured acceptance gate. Completing a model turn, passing checks,
recording acceptance and merging Git changes remain separate actions. Shared
requests show publication and the PullRequest Markdown review note. That note does
not mean a Git-hosting pull request has been created or merged.

**Open conversation** returns to the same request to answer or resume a checkpoint.
Use a new Feature Request for unrelated work. Canonical local requirement changes
reassess the same request; terminal work needs **Reopen request**. Shared-owned
scope continues to require its upstream successor workflow. Request-text rework
proposes revised instructions and consumes model allowance; implementation repair
is a separate bounded delivery step with fresh verification. Other-worker
ownership or inconsistent request identity keeps decisions unavailable.

History’s retained file detail uses the same patch and check components and links
to the complete review page. A reply’s **Review saved patch** opens that same
request context. A failed evidence read offers Retry without removing the task list.
Review it, then check and apply it from the repository:

```sh
git apply --check /path/to/download.patch
git apply /path/to/download.patch
```

Run your project's tests after applying. Patches use captured input, so a changed
checkout may no longer accept a patch. **Retry saved input** retains the original
snapshots; start a new task to capture current files. Terminal results are saved
locally, with review artifacts under `local-review/`.

## Follow and control a delivery run

Request detail shows the Feature Request lifecycle separately from the delivery
run's status and phase. **Execution complete** means the run finished;
**Accepted** means a person accepted its current candidate. The behaviour panel
explains the selected action, evaluated conditions, reason and next expected
event. Ordered activity correlates request events and step receipts with their
recorded identities.

Use **Pause after this step** to finish the current bounded step and wait before
the next. **Interrupt now** requests cessation; **Cancel request** also closes
work once execution has stopped. Pending/unknown stop outcomes remain visible.
**Resume work**, **Retry failed work** and **Reopen request** appear only when the
recorded state permits them. These controls do not erase checkpoints or bypass
missing answers, source conflicts, permissions or mandatory gates.

The project queue's pause control holds new starts and is separate from a
selected run's step pause. Closing or refreshing the webview does not stop the
daemon. Reconnect and inspect the current run before issuing a new command;
repeat an uncertain command with its saved identity instead of creating duplicate
work. Background reads retain focus and unsubmitted answers.

### Recover a provider attempt without a delivery run

If Taskboard shows **Provider processes need inspection**, an uncertain readiness, advisory-review or older provider attempt still reserves capacity, including after restart. Open its attempt evidence, inspect the host and stop any surviving provider processes and development services. Select the exact attempt, acknowledge that inspection and enter a note before **Record operator-confirmed stop**. The worker refuses confirmation while it observes a live controller, owned process or service.

A lost response offers **Retry same stop confirmation**, retaining the run, recovery revision, note and operation ID. Confirmation releases the reservation but preserves the model's unknown outcome and unavailable usage. Retry the Ready Check or continue the request separately when safe. Delivery-owned executions use their request's existing recovery controls. [Headless commands](../reference/portable-apps.md#recover-an-uncertain-provider-attempt) reach the same checks.

## Configure the taskboard and orchestrator queue

History lists conversations from chat, file tasks and orchestrator assignments.
Search by title, ID or provider, filter task type and state, or choose archived
tasks to **Restore and open** a conversation. File tasks also appear in Queued,
Running, and Review & finished columns with their own search and state filter. Inspect file tasks
to stop, change queued priority, retry failed work, archive or delete. The file
taskboard retains at most 100 tasks. Open **Settings → Queue & duration** to configure:

- **Local task capacity:** 1–64 accepted local tasks, counting queued and running
  work and temporary preparation/resume reservations. This does not add execution slots.
- **Shared execution slots:** 1–8, default one. Project policy can impose a lower
  per-project limit; unresolved attempts retain reservations.
- **Extra orchestrator queue places:** 0–64 accepted assignments in the remote
  waiting buffer; defaults to zero and does not add execution slots.
- **Start order:** FIFO or high priority first for queued file tasks.

All provider work shares the machine ceiling. Approved project delivery can run
concurrently within its project limit; the same session cannot execute twice.
Unscoped Chat, legacy work and remote assignments remain exclusive. Queue places
add waiting capacity, not permission to bypass these limits.
Waiting assignments have lease renewal; loss of ownership prevents execution.
The orchestrator remains the authority for assigned tasks. Its task state calls
leased assignments `running`, while the worker distinguishes queued from
executing. Both services must support the queue extension to enable extra places.

**Pause new starts** on Taskboard holds new execution starts, including Chat, file tasks and
already accepted remote assignments. The active task can finish; waiting work
remains queued until resumed. Pausing display updates in the header is separate:
it only pauses refresh of the webview. Reducing queue limits does not discard
accepted work. Configure project concurrency through the [delivery policy](../reference/delivery-policy.md#concurrency-and-dependency-planning)
and the private machine ceiling. Unknown execution reservations count toward
capacity but are shown separately from observed active processes.

Taskboard shows local admission usage separately from accepted remote
assignments. Drafts, finished tasks and ready project notes awaiting admission are not
occupied places. A full local admission limit holds new submissions; a manual
pause or token limit can hold execution while additional work still fits in the
queue. Stale capacity is labelled as last reported, not current availability.

Queue, duration and consumption editors preserve drafts while you navigate
Settings in this tab. Save each section explicitly. If another operator changes
its saved policy, reload and reconcile your draft before saving. A successful
save followed by a failed refresh does not imply that the change was rejected.

Queued file tasks survive restart. Known interrupted execution requires an
explicit retry; an unknown provider outcome keeps its capacity reservation until
reconciliation or operator-confirmed cessation. Orchestrator assignments are reconciled from the
server and existing terminal evidence is not executed again.

## Connect an orchestrator later

In **Settings → Orchestrator**, enter its HTTP(S) origin and enrollment token, then
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

Open **Settings → Execution profiles**. These are the IDs/providers offered for
orchestrator assignments, separate from provider sign-in, model settings and
imported agent definitions. A simulated worker supports 1–8 Claude/Codex profiles;
a worker already configured for native Linux Codex supports one Codex profile.
Editing keeps the current execution mode and exclusive orchestrator assignment
semantics. Project provider choices belong to **Settings → Project delivery**;
**Queue capacity** separately configures the worker's machine execution ceiling.

1. Finish or stop queued/running tasks and active replies, then **Pause new starts**.
   Pausing leaves queued work in place; resume to finish it or stop it before editing.
2. Edit **Profile ID** and **Provider**, using **Add profile** or **Remove** where
   available. IDs must be unique; changing an ID changes its routing name.
3. Choose **Save profiles**. Before first registration, the change takes effect
   immediately. A registered worker shows **Waiting for the orchestrator** until
   the same orchestrator accepts the update; the old profiles remain active.
4. Once the update is accepted, choose **Resume new starts** on Taskboard when ready.

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
the same session and use the worker's shared execution capacity. Configure providers
and manage sessions in the worker itself. If another operator changes the
selected session, reconnect before sending more messages.

The worker token stays in dialog memory and is passed through authenticated
service requests; it is not saved in URLs or browser storage. Close clears the
widget connection, but does not delete the worker-owned task session. The widget
forwards requests; only the worker prompts an LLM.

Use the separate **Submit task** tab when work should enter the line's configured
router. Supply a requirement link or title and acceptance criteria. That router
chooses an eligible worker independently of the widget's connected worker.
New task queues work directly on the connected worker. In that worker's own
interaction panel, optional repository-file approval can produce a review patch
from captured inputs. Routing and file permissions remain separate decisions;
all admitted work executes serially on whichever worker owns it.

## Inspect History and Metrics

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

Metrics shows the configured token allowance, resource observations, retained
execution evidence and operational health. Measurement age and missing readings remain
visible. Settings links open the corresponding editor without mixing forms into
the measurements. Standalone mode is healthy without an orchestrator.

The delivery metrics cohort includes eligible local/shared submissions observed
before readiness or admission succeeds, even when no implementation has started.
The same request is counted once after admission. Ready Check provider time,
recorded clarification answers and waits remain linked to that feature. Missing
or truncated evidence remains unknown; it is not an invented completion or cost.

**All time** also includes historical submissions with an unknown original time.
Choosing a date range excludes those requests and displays the excluded count.
Do not interpret an empty dated cohort as proof that no older submissions exist.

The **Services & execution processes** section reports owned development services
and observed model, tool, MCP and Git processes separately from the worker Node
process. It links each attributed process to its Feature Request, shows sampling
coverage and exposes granted service stop/restart controls and bounded logs. See
[manage worker processes](manage-worker-processes.md) for lifetime, restart and
platform behavior.

Worker Node CPU/RSS excludes provider subprocesses; host memory/load includes
other machine activity and does not prove container quota. Execution evidence
summarizes local invocations with coverage, while original remote assignments
retain their separate snapshot history. Reported costs may be estimates;
subscription balance and model progress are not inferred from these metrics.

**Settings → Consumption** sets this worker's share of a configured
daily or monthly token allowance. It shows measured usage, reservations,
remaining tokens and the next UTC reset. Limits start disabled. When enabled,
insufficient budget holds new model calls while accepted work stays queued;
personal use outside the worker remains unmeasured. Follow
[set a worker consumption limit](worker-consumption-limits.md) for setup and
recovery from incomplete usage.

Visible pages poll for current observations; header controls pause readings
or refresh manually. Failed reads retain the last observation with a stale-data
warning; successful reads still update independently. A successful action remains
accepted if its follow-up refresh fails, avoiding a misleading retry prompt.
No environment-variable values or credentials are shown.

## Answer a question or continue after interruption

The taskboard places a pending question or escalation in **Needs you** and opens its answer controls in **Follow up**.
Read its reason/choices, enter your response and submit through the pending-input
control. Generic follow-up sending is held until that decision is resolved.
Taskboard and History identify requests needing input and link back to the selected task on the taskboard.

Inspect the saved checkpoint before resuming a compatible failed or interrupted
turn. Canonical cancelled or accepted requests require explicit reopening. Continuation replays saved context in a fresh invocation and may consume
additional tokens. Restart alone does not repeat ambiguous work. Latest-turn
consumption shows measured values and unavailable fields; a reported estimate is
not a billed amount. See [answer and resume](answer-and-resume-worker.md) for the
equivalent human/agent CLI workflow and stable operation-key rules.
