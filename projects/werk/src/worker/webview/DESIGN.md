# Worker workspace direction

## THESIS
Operate mode. One independently runnable worker, exactly three pages: Chat
(default), History and Dashboard. Dashboard contains Monitoring & Status; the
legacy `/monitoring-status` route redirects to `/dashboard`. Vue with Nuxt UI is
the user-pinned implementation. One worker executes exactly one task at a time;
additional worker instances provide parallelism.

## OWN-WORLD
Extend Werk's existing dark slate and mint operational identity. Preserve readable system typography, 44px controls, private credentials and honest mock labels. This is a local worker detail surface.

## STORY
Persistent page navigation anchors the worker identity. After unlock, Chat is the
primary task entry. Its searchable task rail keeps saved tasks and their states
beside the transcript. New task selects a provider connection, an optional Docker
Agent definition and a named agent before creating a dedicated provider session;
the first message queues the task and follow-ups preserve that session. One worker
executes one task at a time across chat, file tasks and remote assignments. The
explicit Run task editor creates a separate file-task session producing a review
patch from approved inputs. Every remote assignment also owns a dedicated task
session. Only workers prompt LLMs; parent dashboards forward requests or route
submitted tasks. History lists chat tasks with Open task actions, a three-column
file-task board and retained orchestrator evidence. Dashboard starts with queued,
running and review work, session activity and waiting remote assignments. It
joins worker, optional orchestrator and journal in a 2D connection map, then
shows process and host observations. Provider connections and enrollment are
editable within a disclosure. Chat also opens provider settings and saved
connection checks inline. CLI sign-in instructions name the worker machine and
process owner; configuration does not verify login or quota.
Standalone is a healthy state, not an onboarding error. Chat, file tasks and
remote assignments share one execution slot. Show accepted-but-waiting work as
queued, never as concurrent model execution. Pause holds all new starts and lets
the active task finish. Scale with separate native/Docker workers, not a
per-worker concurrency control.

Docker Agent definitions open in a separate inline Chat disclosure. File upload or
pasted YAML leads to a preview of each agent's instructions, model and unsupported
features before import. Import does not execute the definition. New task requires
explicit instructions-only acceptance when features are omitted and shows a
provider mismatch before creation. A task disclosure presents its fixed agent
snapshot, so definition removal or later imports cannot silently change the task.
Run task has its own definition and agent selection for the separate file task.

## FIRST VIEWPORT
Before unlock, a dedicated access screen focuses on one token field, a visibility
toggle and Unlock worker. Local file guidance and expandable help distinguish
workspace access from provider sign-in. A separate HttpOnly session preserves
access across reloads for up to 12 hours; Lock, expiry or a worker restart returns
to unlock. The durable access token is cleared after successful entry and is not
saved in browser storage, the session cookie or a URL. Expired access keeps
unsent drafts in the current tab; explicit Lock clears them. Running tasks
continue on the worker.

After unlock, the active page and worker state are immediate. Chat starts with a
useful empty state, a visible New task action and composer, and an inline provider
connection prompt when a model is unavailable. Connections and Agent definitions
stay secondary to the conversation. The task rail shows readable names, provider
and task state; task settings disclose rename, archive and confirmed deletion.
Replies support paragraphs, lists, emphasis, inline code and fenced code with a
Copy code action. Model output remains text rather than interpreted HTML. The
composer accepts a draft while the selected task is running; sending a follow-up
waits for that task to finish. Queued and running states have distinct copy and
cancel/stop actions. A persistent
Tour action replays a guided introduction across the three pages, including
sessions, Run task, History and Dashboard. The tour navigates and explains;
it does not configure providers, enroll the worker or submit work.

## FORM
Code-led, native Nuxt UI components and authored 2D system geometry. The dedicated
unlock form has a narrow reading measure and generous space around its primary
action. In Chat, a divided task rail sits beside the transcript on wide screens;
below 900px it becomes a horizontal task strip above the conversation. The main
sidebar becomes three-link top navigation at 760px and below. Inline connection,
definition and new-task panels use the existing bordered slate surfaces and mint
actions. Long task names wrap, code scrolls within its own block, and task and
provider states include text rather than relying on color. Evidence details
disclose progressively, and background updates preserve reading position. No
decorative 3D model is needed for one worker's three pages.

## FINISH
Keep documented routes, labels and capability limits aligned with the actual
workspace. Record dated review evidence separately; this surface brief does not
claim that a current build has passed final review or live-provider verification.
Preserve keyboard focus, mobile navigation, stale-data feedback, private access
and unsent work during page changes. Local tasks produce review artifacts from
approved inputs; they do not apply patches or run project tests automatically.
