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
Persistent page navigation anchors the worker identity. Chat is the primary task
entry. New task creates a dedicated provider session;
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
editable within a disclosure; configuration does not verify login or quota.
Standalone is a healthy state, not an onboarding error. Chat, file tasks and
remote assignments share one execution slot. Show accepted-but-waiting work as
queued, never as concurrent model execution. Pause holds all new starts and lets
the active task finish. Scale with separate native/Docker workers, not a
per-worker concurrency control.

## FIRST VIEWPORT
The active page and worker state are immediate. Chat starts with a useful empty
state and a visible New task action and composer. Access is an inline credential
panel with a precise
local file instruction; no token enters browser storage or a URL. A persistent
Tour action replays a guided introduction across the three pages, including
sessions, Run task, History and Dashboard. The tour navigates and explains;
it does not configure providers, enroll the worker or submit work.

## FORM
Code-led, native Nuxt UI components and authored 2D system geometry. Responsive sidebar becomes a three-link top navigation. Text wraps, evidence details disclose progressively, and updates preserve the user's current reading position. No decorative 3D model is needed for one worker's three pages.

## FINISH
Keep documented routes, labels and capability limits aligned with the actual
workspace. Record dated review evidence separately; this surface brief does not
claim that a current build has passed final review or live-provider verification.
Preserve keyboard focus, mobile navigation, stale-data feedback, private access
and unsent work during page changes. Local tasks produce review artifacts from
approved inputs; they do not apply patches or run project tests automatically.
