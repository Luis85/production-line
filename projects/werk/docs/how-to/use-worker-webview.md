# Use the worker webview

Extract a verified prebuilt archive directly into a fresh WerkHome and start
`node worker.mjs`. Node 24 and Git are required; no npm install, source checkout or
project-local worker is needed. The root launcher's directory anchors Home,
regardless of cwd. Startup prints the secure local URL and private credential-file
path. Fresh private state is `Home/state/worker`; cloned repositories are visible
at `Home/projects/<id>`, and replaceable application files are in `Home/runtime`.

Four primary navigation destinations lead to focused views. Every focused view
has one operator goal:

| Destination | Use it to |
| --- | --- |
| Workboard · `/workboard` | Choose the next request to advance; Needs you comes first. |
| Projects · `/projects` | Choose a project and open its next setup action. |
| Workflow · `/workflow` | Understand recorded flow and confirmed delivery velocity. |
| Settings · `/settings` | Choose one independently saved worker setting. |

Workboard opens after unlock/setup. **New Feature Request** opens
`/requests/new` for preparation, readiness and explicit Git publication; project
and draft identity remain in its query. An existing conversation opens at
`/request?session=<id>`. A pre-admission shared request opens at
`/request?project=<id>&request=<name>`, including its Ready Check. Review
(`/review`) owns the exact candidate decision. Retained file-task priority, retry
and cleanup open `/request/maintenance?fileId=<id>`.

**Add a project** opens `/projects/new`. The chosen project's
`/project?project=<id>&step=workflow|policy|enable|edit|intake` views separately
prepare workflow files, approve committed policy, recheck readiness, edit a policy
draft or configure request polling. **Delivery quality evidence**
(`/workflow/evidence`) inspects outcome cohorts. **Worker health** (`/dashboard`)
shows resources and consumption; **History** (`/history`) opens read-only evidence.

Legacy `/taskboard`, `/chat` and Workboard session bookmarks preserve the exact
session at `/request`; unscoped bookmarks open Workboard. Old Projects project
queries open the selected project; project plus request opens that request.
`/monitoring-status` opens Worker health. Earlier settings bookmarks reach their
focused editor or project workflow. Choose **Tour** for a replayable introduction
that changes no worker configuration.

## Use requests from project files

The Feature Request is the central workflow entity. The webview and Markdown
notes are ways to create, inspect and respond to it; sessions, attempts, questions
and review notes belong to that request. [Project setup](project-worker.md) previews and commits the project
workflow/template without installing an app into the project. A shared repository
uses [shared Git intake](shared-feature-intake.md) for requests from either interface.
New Home projects use that shared Git handoff. Retained legacy request records
keep their source authority; they are not an alternative primary submission flow.

## Unlock the webview

The dedicated unlock screen protects the workspace until access succeeds. Read the private credential file named by the Home launcher and paste its token
into **Worker access token**. The token remains in private effective state; root
`status` reports its file path. Home startup does not depend on a project `.env`.
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

Use **Settings → Provider connections**. Settings itself is a grouped directory;
each selected destination opens one editor with its own save. Default provider,
Queue capacity, Execution time limits and Token allowance are separate editors.
**Saved project authority** only revokes retained grants; new policy approval
belongs to the selected project. Optional coordination separates Execution
profiles, Orchestrator connection and Assigned request rules. Central Home's old
project-settings links lead to Projects or the selected project; retained Factory
configuration stays available in its applicable legacy context.
Workboard links directly to this editor when a provider needs setup.
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

Select **Cursor CLI** in **Settings → Provider connections**, save its executable,
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
including native subagent usage, are unavailable in this adapter. Worker health shows
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

In **Settings → Default provider**, save **Default provider for new requests**
to choose the connection offered for new intake. This is separate from connecting
and checking an account in **Settings → Provider connections**. Each connection has
**Default model** and **Default effort**. Save the connection after changing
those defaults. Existing provider-save restrictions still apply while work is
queued or running.

In **Request options** for a project Feature Request draft,
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

Choose **Workboard → New Feature Request**, select a ready project and its
committed template, then describe the observable outcome.

1. Choose **Prepare request**. It loads the committed template without starting
   implementation.
2. Complete Goal, Context, Acceptance criteria, Verification plan and approved
   paths. Inspect the draft and run **Check readiness**.
3. Use **Save draft to Git** for unfinished authoring, or **Mark ready and publish**
   after readiness passes. Both commit and push to the displayed branch; only a
   ready request can proceed through the shared claim and admission gates.
4. Follow the same request's live stages, questions and review from Workboard.
   Use its guarded answer/resume controls for required input. Shared answers are
   published to Git before the existing response consumer resumes work.

New Feature Request is project Git authoring, not generic local-chat dispatch.
Unpublished edits and unknown acknowledgements stay attached to their original
command identity. Reconcile or retry that exact operation; do not submit another
request to recover a missing acknowledgement. A changed remote source, template
or binding requires fresh inspection rather than overwrite.

Changing accepted scope requires the supported rework/successor path. Provider
completion does not establish acceptance or merge. Open Review to inspect diff,
independent checks and current-candidate human decisions; verbose execution
identities remain available through disclosures and History. Passing checks and
acceptance do not silently mutate the main checkout.

Legacy conversations, file tasks and assignments remain retained evidence with
their original source authority. They do not replace new project Feature Request
authoring. Do not create a local watcher over the same shared queue.

## Answer a Ready Check from Workboard

Open the request's Ready Check card. It opens the exact project/request in its
focused request view (`/request?project=<id>&request=<name>`), independently of
project configuration. Inspect the findings, then use **Answer
the Ready Check → Your answer to the Ready Check** and **Commit and push answer**.
The worker commits the canonical answer; normal shared intake rechecks it before
implementation. The main request Markdown preview remains read-only.

A lost acknowledgement exposes **Retry same answer publication**, preserving the
exact body and operation identity. If the checkpoint changes while you type, your
draft remains until you explicitly discard it and inspect the current questions.
A retained pending/published receipt blocks another answer for that checkpoint,
including after reopening. Do not submit a new Feature Request to recover it.

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

Open **Projects → Add a project** to clone the configured remote/branch.
New registration is clone-only; it does not adopt an arbitrary existing checkout
or infer that Home is a source repository. The visible destination is
`Home/projects/<id>`. Choose a repository-relative **Feature Request folder**
(default `features`) and polling interval (default 30 seconds; allowed 1–300 seconds).

From Projects, choose the exact project. In **Workflow files**, inspect the
proposed files/baseline and approve their commit/push. Continue to **Policy
approval** to inspect and approve the exact committed authority, then **Enable
requests** to recheck setup. Each stage retains the selected project and opens
only that operation. **Edit project delivery policy** and **Configure request
polling** open separate project-scoped editors. Projects exposes status and
recovery for incomplete setup. Existing tracked
customization remains preserved. Unknown pushes reconcile before a new operation.

Retained legacy clone locations remain verified at their exact saved paths and
are labelled as retained locations, never moved automatically. External adopted
legacy rows do not authorize new execution. Private ownership markers, outboxes
and task worktrees stay beneath effective worker state rather than in the
visible clone. See [project setup](project-worker.md).

## Run local coding tasks

The following limits describe retained local approved-file records and their
legacy executor. New Home work starts with the project's Feature Request draft
and shared Git handoff above; this is not a second primary creation flow.

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
scope changes continue to require its upstream successor workflow. Candidate-bound
**Request changes** can continue shared review within its accepted scope: the worker
confirms feedback on the shared branch before starting rework on the same request
and PR. Request-text rework
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

If Workboard shows **Provider processes need inspection**, an uncertain readiness, advisory-review or older provider attempt still reserves capacity, including after restart. Open its attempt evidence, inspect the host and stop any surviving provider processes and development services. Select the exact attempt, acknowledge that inspection and enter a note before **Record operator-confirmed stop**. The worker refuses confirmation while it observes a live controller, owned process or service.

A lost response offers **Retry same stop confirmation**, retaining the run, recovery revision, note and operation ID. Confirmation releases the reservation but preserves the model's unknown outcome and unavailable usage. Retry the Ready Check or continue the request separately when safe. Delivery-owned executions use their request's existing recovery controls. [Headless commands](../reference/portable-apps.md#recover-an-uncertain-provider-attempt) reach the same checks.

## Configure the taskboard and orchestrator queue

History offers mutually exclusive read-only request, file-task, execution,
project-request and assigned-attempt views. Search and filter retained evidence;
browsing does not select a conversation, restore archived work or control the
queue. Explicit request links open the exact existing request. Retained file-task
priority, retry and cleanup open **Manage saved task** at
`/request/maintenance?fileId=<id>`; those actions retain their original checks.
The file-task store retains at most 100 tasks.

Open **Settings → Queue capacity** to configure:

- **Local task capacity:** 1–64 accepted local tasks, counting queued and running
  work and temporary preparation/resume reservations. This does not add execution slots.
- **Shared execution slots:** 1–8, default one. Project policy can impose a lower
  per-project limit; unresolved attempts retain reservations.
- **Extra orchestrator queue places:** 0–64 accepted assignments in the remote
  waiting buffer; defaults to zero and does not add execution slots.
- **Start order:** FIFO or high priority first for queued file tasks.

**Settings → Execution time limits** separately saves attempt duration, warnings
and bounded tool/wait limits. Its save does not replace queue capacity policy.

All provider work shares the machine ceiling. Approved project delivery can run
concurrently within its project limit; the same session cannot execute twice.
Unscoped Chat, legacy work and remote assignments remain exclusive. Queue places
add waiting capacity, not permission to bypass these limits.
Waiting assignments have lease renewal; loss of ownership prevents execution.
The orchestrator remains the authority for assigned tasks. Its task state calls
leased assignments `running`, while the worker distinguishes queued from
executing. Both services must support the queue extension to enable extra places.

**Pause new starts** on Workboard holds new execution starts, including Chat, file tasks and
already accepted remote assignments. The active task can finish; waiting work
remains queued until resumed. Pausing display updates in the header is separate:
it only pauses refresh of the webview. Reducing queue limits does not discard
accepted work. Configure project concurrency through the [delivery policy](../reference/delivery-policy.md#concurrency-and-dependency-planning)
and the private machine ceiling. Unknown execution reservations count toward
capacity but are shown separately from observed active processes.

Workboard shows local admission usage separately from accepted remote
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

In **Settings → Orchestrator connection**, enter its HTTP(S) origin and enrollment token, then
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
semantics. Project provider choices belong to the selected project's
**Policy approval** or **Edit project delivery policy** view;
**Queue capacity** separately configures the worker's machine execution ceiling.

1. Finish or stop queued/running tasks and active replies, then **Pause new starts**.
   Pausing leaves queued work in place; resume to finish it or stop it before editing.
2. Edit **Profile ID** and **Provider**, using **Add profile** or **Remove** where
   available. IDs must be unique; changing an ID changes its routing name.
3. Choose **Save profiles**. Before first registration, the change takes effect
   immediately. A registered worker shows **Waiting for the orchestrator** until
   the same orchestrator accepts the update; the old profiles remain active.
4. Once the update is accepted, choose **Resume new starts** on Workboard when ready.

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

## Inspect Workflow

Open **Workflow** for delivery observations across retained Feature Requests.
Choose **Project** and **Completed within** before comparing results.
**Observed workflow** stage pressure spans all submission dates at the displayed observation time; velocity
uses confirmed completion times in the selected window. An old request completed
this week belongs in this week's velocity even if it was submitted months ago.

**Weekly delivery velocity** counts confirmed increments: the reviewed candidate merged into
the main checkout, or the release published when the request requires release
publication. Human acceptance, passing checks and successful provider calls do
not count as delivered increments. Review-only closure remains separate. UTC
weeks start on Monday; partial boundary weeks are labelled and excluded from the
complete-week average. This is a count of increments, without story points.

Read **Delivery measures** and **Measurement coverage and definitions** alongside
lead/cycle times and rework/failure observations. Lead time runs from the recorded
submission to confirmed integration; cycle time starts at the first recorded
implementation/repair start. Unknown timestamps and incomplete retained history are not zero.
The Evidence-based management section distinguishes operational proxies from
unmeasured customer value, opportunity and innovation outcomes. Follow a request
to Review or History when you need its underlying decisions and evidence.

See the [Workflow measurement contract](../reference/worker-run-metrics.md#workflow-webview)
for completion rules, window boundaries and coverage. Failed refreshes retain a
matching **Last successful snapshot**; changing filters clears results from the
previous scope while the new observation loads.

<a id="inspect-history-and-metrics"></a>

## Inspect History and Worker health

History opens one evidence view at a time: **Requests**, retained file-task
evidence, **Execution attempts**, **Project requests** or **Assigned attempts**.
Request browsing does not select another worker session or restore an archived
record. Explicit links open the exact request, Review or maintenance workflow.
No queue controls appear in History.

Execution evidence retains local Chat/file/feature runs, paired observations and
provider-reported consumption; filters and export support comparison. Original
orchestrator assignments retain their own before/after snapshot contract.
Simulated attempts remain labelled. Missing usage and unreadable evidence remain
unknown. Snapshot history follows retention; the reader inspects at most 1,000
directories and discloses bounded coverage. See the
[run metrics contract](../reference/worker-run-metrics.md) and
[complete worker lifecycle](../tutorials/worker-feature-lifecycle.md).

Worker health (`/dashboard`) shows the configured token allowance, resource
observations, invocation activity and operational health. Measurement age and
missing readings remain visible. Settings links open independent editors.
Standalone mode is healthy without an orchestrator.

**Workflow → Delivery quality evidence** (`/workflow/evidence`) owns delivery
outcome cohorts. Eligible local/shared submissions can appear before readiness or
admission succeeds, even when implementation has not started; a request is counted
once after admission. Ready Check provider time, clarification answers and waits
remain linked to that request. Missing/truncated evidence is unknown rather than
invented completion or cost. **All time** includes historical submissions whose
original time is unknown; date ranges exclude them and display that count. An
empty dated cohort does not prove that no older submissions exist.

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

**Settings → Token allowance** sets this worker's share of a configured
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

Workboard puts a pending question or escalation in **Needs you** first. Open the
exact request to use its checkpoint answer controls.
Read its reason/choices, enter your response and submit through the pending-input
control. Generic follow-up sending is held until that decision is resolved.
Workboard and History identify requests needing input and link to that exact
request; browsing History does not change the worker's selected session.

Inspect the saved checkpoint before resuming a compatible failed or interrupted
turn. Canonical cancelled or accepted requests require explicit reopening. Continuation replays saved context in a fresh invocation and may consume
additional tokens. Restart alone does not repeat ambiguous work. Latest-turn
consumption shows measured values and unavailable fields; a reported estimate is
not a billed amount. See [answer and resume](answer-and-resume-worker.md) for the
equivalent human/agent CLI workflow and stable operation-key rules.
