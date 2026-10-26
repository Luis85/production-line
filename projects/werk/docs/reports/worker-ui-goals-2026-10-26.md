# Worker interface goals review · 2026-10-26

Method: dual-agent (A: `ui_goal_design_review` · B: `ui_goal_browser_review`).

## Scope and acceptance criteria

The target is `src/worker/webview`, preserving the existing slate/mint Vue and
Nuxt UI interface. The user requested a thorough review and implementation polish,
with exactly one user goal on every focused view. This report records the baseline
assessment and selected implementation contract; verification below is explicit
about the evidence obtained.

Acceptance criteria:

1. Each focused view names one operator outcome. Creation, conversation, setup,
   approval, editing, maintenance and read-only evidence do not compete on one page.
2. Workboard prioritizes Needs you, preserves exact request identity and opens
   creation/conversation elsewhere. Narrow screens reach urgent actions promptly.
3. Project setup keeps one selected project across workflow publication, exact
   policy approval and readiness recheck. Clone registration stays explicit.
4. Settings is a grouped directory of independently saved editors. Queue,
   execution limits, provider connection/default and connection/request policy
   remain separate saves; drafts and conflict protection survive navigation.
5. History has mutually exclusive read-only evidence views. Browsing never selects
   another session, restores archived work or changes a queue. Explicit action
   links open the exact request, Review or retained file maintenance.
6. Workflow health and delivery-quality evidence have distinct focused views.
   Worker health owns resource/consumption observations rather than delivery cohorts.
7. Review distinguishes passed required checks from pending human acceptance.
   Exact candidate proof, missing evidence and the valid next decision remain clear.
8. Legacy bookmarks retain query identity. No substitute request, project or
   candidate is silently selected when the requested record is missing.
9. Preserve safety and truth: stale evidence blocks decisions; uncertainty retains
   operation identity; Git publication, acceptance, merge and release stay distinct;
   unknown usage is not zero; provider configuration does not establish account
   authentication, quota, model access or measured cost.
10. Verify the changed journeys at desktop and mobile sizes, including keyboard,
    draft retention, route compatibility and the project's required checks. Record
    actual results rather than inferring them from source or screenshots.

## Focused route and goal catalogue

| Route or selected view | Exactly one user goal |
| --- | --- |
| Locked workspace | Unlock this worker. |
| `/workboard` | Choose the next request to advance. |
| `/requests/new` | Publish a ready Feature Request. |
| `/request?session=<id>` | Advance the exact existing request conversation. |
| `/request?project=<id>&request=<name>` | Resolve or inspect the exact pre-admission shared request. |
| `/request/maintenance?fileId=<id>` | Manage one retained file task's priority, retry or cleanup. |
| `/projects` | Choose a project. |
| `/projects/new` | Clone and register one remote project. |
| `/project?project=<id>&step=workflow` | Publish the project's missing workflow files. |
| `/project?project=<id>&step=policy` | Approve the exact committed project authority. |
| `/project?project=<id>&step=enable` | Recheck the project to enable request intake. |
| `/project?project=<id>&step=edit` | Edit one project delivery-policy draft. |
| `/project?project=<id>&step=intake` | Configure one project's request polling. |
| `/review` with its retained identity | Decide the next valid action for this exact increment. |
| `/workflow` | Understand delivery health from recorded flow and velocity. |
| `/workflow/evidence` | Inspect delivery-quality cohorts and coverage. |
| `/dashboard` | Understand worker resource health. |
| `/history` | Find a retained request. |
| `/history?view=files` | Find retained file-task evidence. |
| `/history?view=runs` | Inspect a recorded execution attempt. |
| `/history?view=features` | Inspect retained project/shared-request evidence. |
| `/history?view=assigned` | Inspect an assigned attempt. |
| `/settings` | Choose one worker setting. |
| `/settings#provider-connections` | Connect and check one model provider. |
| `/settings#default-provider` | Choose the starting provider for new requests. |
| `/settings#queue` | Set request admission and execution capacity. |
| `/settings#duration-policy` | Set execution time limits. |
| `/settings#consumption-limits` | Set the worker token allowance. |
| `/settings#tool-access` | Grant bounded tool access. |
| `/settings#agent-definitions` | Prepare reusable agent instructions. |
| `/settings#retained-approvals` | Revoke saved project authority. |
| `/settings#execution-profiles` | Advertise optional orchestrator execution profiles. |
| `/settings#orchestrator` | Connect an optional orchestrator. |
| `/settings#request-policy` | Set assigned-request rules. |

A route can contain supporting evidence and the safe steps needed for its single
outcome. A second independently saved editor or unrelated mutation is a separate
view. Project and draft query identity remain attached to authoring. Legacy
`/taskboard`, `/chat` and Workboard session bookmarks open the exact `/request`;
unscoped bookmarks open Workboard. Old Projects project queries open `/project`;
project plus request opens `/request`. Central Home's earlier project settings
lead to Projects or a scoped project. Retained Factory/legacy configuration is
still available in its applicable context.

## Baseline design health

Assessment A judged design specificity before receiving detector or Assessment B
findings. Werk's visible checkout paths, Git handoff, exact policy approval and
candidate evidence make the interface product-specific. Its calm slate/mint
identity and familiar controls should remain. Composition and page ownership,
rather than a replacement visual theme, are the main opportunity.

| Nielsen heuristic | Score / 4 | Baseline finding |
| --- | --- | --- |
| Visibility of system status | 3 | Strong freshness/uncertainty; completion summary confuses pending acceptance with failed checks. |
| Match with real world | 3 | Appropriate developer vocabulary; profile/policy distinctions add setup friction. |
| User control and freedom | 3 | Draft exits work; conversation is appended underneath the board. |
| Consistency and standards | 3 | Cohesive controls; Workboard/Taskboard terminology varies. |
| Error prevention | 4 | Explicit publication, exact-policy consent, immutable retries and stale guards. |
| Recognition over recall | 2 | Approval and setup recheck require remembering context across selectors. |
| Flexibility and efficiency | 2 | Filters/deep links help; long serial forms and mobile scanning slow work. |
| Aesthetic and minimalist design | 2 | Calm appearance; multiple independently actionable workflows share pages. |
| Error recovery | 3 | Preserved drafts and saved-operation recovery; cross-section setup recovery. |
| Help and documentation | 3 | Useful contextual guidance can obscure the next action. |
| **Total** | **28 / 40** | **Good foundation; page-goal boundaries need work.** |

This is a baseline design assessment, not a score for the changed implementation.

## Evidence and priorities

Assessment A captured 10 representative stories at 1440×1000 and 390×844 in
`/tmp/worker-assessment-a`. No captured page overflowed the viewport width.
Closing and reopening request authoring retained the entered Goal. Assessment B
independently inspected 14 screens in 19 inspections with zero observed horizontal
overflow errors; its before evidence is in `/tmp/werk-ui-goal-audit-before`.
These are isolated static fixtures, not live-provider execution evidence.

| Priority | Baseline evidence | Selected implementation response |
| --- | --- | --- |
| P1 · project ownership | Projects mounted registration, workflow publication, optional request progress and the policy editor together; desktop capture was 3,606px tall. | Project directory, separate clone page and project-scoped workflow/policy/enable/edit/intake views. Keep consent evidence with its action. |
| P1 · independent operations | Queue/duration had two saves; History mounted conversations, an active file-task board and assigned history; Metrics included delivery outcomes. | Independent settings editors, mutually exclusive read-only History, focused maintenance and delivery-quality evidence views. |
| P1 · mobile triage | Needs you began near y=1,918 and Answer task near y=2,163, after queued cards and an empty running lane. | Attention-first Workboard with compact lane access; open conversation separately. |
| P2 · authoring order | Mobile Goal began near y=1,594 after execution profile, quality, priority and dependencies; readiness/publication near y=2,632–2,767. | Outcome-first authoring with its own heading; optional routing detail discloses progressively. Keep approved scope and publication consequences clear. |
| P1 · review truth | Verified candidate said “Recorded checks have not passed” while required implementation checks passed and only human acceptance was missing. | Name passed required checks and pending acceptance separately; preserve the completion gate. |

Representative A screenshots: `worker-workboard-journey--visible-home-projects-desktop.png`,
`worker-workboard-journey--review-lane-mobile.png`,
`worker-workboard-journey--canonical-request-mobile.png`,
`worker-review--verified-candidate-desktop.png`,
`worker-workspace--task-history-desktop.png` and
`worker-workspace--worker-dashboard-desktop.png` in the A directory above.

## Cognitive load, emotional journey and personas

The Workboard baseline combines view choice, creation, search, project filter,
selected-task continuation and four evidence links before the lanes. Settings
presents 11 peer destinations; grouping and one selected editor reduce that load.
Authoring asks optional execution questions before the requested outcome. History
repeats requests across conversation and file-task views. Safety evidence is
necessary complexity: revision identity, authority, freshness, required checks
and publication scope must stay associated with the relevant decision.

The visual system starts calmly. Confidence drops when project setup crosses
registration, file publication, approval and recheck without a single selected
project journey. Authoring introduces another valley by presenting configuration
before intent. Review's next-action panel restores confidence, then contradictory
check language weakens it. Precise pending-acceptance language preserves the
safeguard while removing that confusion.

- First-time operator: profile/policy terms appear before the outcome; setup spans
  several selectors. Focused stages should name the next action and retained project.
- Frequent developer: long forms, repeated setup guidance and duplicate evidence
  increase scanning cost. Urgent mobile work must precede waiting cards.
- Cautious reviewer: failed-check language for missing acceptance can prompt an
  unnecessary investigation or rerun. Name the unmet fact without weakening gates.

Strengths to preserve: exact-policy and Git consent, clear unknown/stale states,
the prominent current next action on Review, stable drafts and responsive wrapping.
Minor cleanup includes consistent Workboard terminology, removing repeated
creation headings and retaining readable, concise coverage explanations.

Design questions retained for future work: can each heading finish “I am here
to…” with one outcome; does every project expose one next valid action; which
facts authorize the current decision versus merely explain its history?

Questions skipped: the user authorized review followed by improvements; no
additional preference decision was required to apply the one-goal contract while
preserving the existing visual identity and safety boundaries.

## Verification and run limits

Retained evidence: [verification receipt](../evidence/archive/worker-ui-goals-2026-10-26/verification.json),
[mobile Workboard](../evidence/archive/worker-ui-goals-2026-10-26/workboard-mobile.png),
[request authoring](../evidence/archive/worker-ui-goals-2026-10-26/new-request-desktop.png),
[exact policy approval](../evidence/archive/worker-ui-goals-2026-10-26/project-policy-desktop.png)
and [stale Review](../evidence/archive/worker-ui-goals-2026-10-26/review-stale-desktop.png).

Documentation validation: `vault check --strict` passed with zero errors and
zero warnings; informational orphan-attachment findings remain visible and were
not suppressed. The project-wide check reports 438 informational findings across
4,414 files after the new evidence was retained. `git diff --check` also passed.

Post-change verification on the polished working tree:

- Initial browser sweep: 240 desktop/mobile story cases; no document overflow.
  Five story failures (ten viewport cases) exposed navigation expectations and
  project recovery issues. They were corrected, preserving the identity assertions.
- Confirmation: all 68 selected desktop/mobile cases pass, combining the 64
  passing confirmation cases with four passing reruns of the last two navigation
  stories. This includes all ten project-goal journeys and lost-answer recovery.
- All ten standalone authoring desktop/mobile cases pass. The model-editing
  example now explicitly opens Execution options before its nested provider
  controls, rather than trying to focus a hidden field.
- Independent finish review: SHIP; 32 captures covering 16 selected stories,
  no blocking goal, identity, consent, stale-data or recovery issues. Sampled
  primary-action text contrast measured 11.18:1. Its minor retained task shortcut
  target-size finding was corrected to 44 px.
- All 126 remaining catalogue desktop/mobile cases pass actual readiness,
  console/page errors, overflow and declared-component mount checks.
- Catalogue declarations now match the actual scenario: private-instruction
  retention does not claim the unmounted prepared-details editor. Prepared
  scenarios retain that editor coverage. The long unbroken project-name case
  also exposed a narrow-screen row overflow; project names now wrap. Windows
  temporary-directory cleanup retries transient filesystem locks within a bounded
  budget, preserving assertions and the existing test time limits.
- All quality gates pass: lint, LOC, dead-code/architecture analysis, application
  and test types. The full local suite exposed two old direct-evaluation test
  harnesses; their props/ports and read-only History contract were updated. All
  19 focused race/recovery/isolation cases then passed, including the new focused
  request navigation case. Final complete-suite results are in the PR checks.
- Real-worker source browser smoke: 11 acceptance groups, 19 screenshots,
  zero page errors or document overflow. It covers immutable answer recovery,
  archived read-only History, settings CAS/retry, restart, Lock and exact patch Review.
- Verified extracted Home browser journey: startup/unlock, actual project clone
  and acknowledged registration, explicit workflow commit/push, exact-policy
  approval, intake recheck, request publication, candidate verification and Git
  publication, Markdown PR, human acceptance and explicitly approved main merge.
  Seven screenshots; zero page errors. This working-tree archive is labelled
  dirty and does not claim clean-commit provenance.

The automated provider is a labelled deterministic Claude CLI protocol fixture;
Git, journals, browser, HTTP and candidate/merge checks are real. This does not
establish account authentication, quota, live inference, native Windows live
qualification or real release publication. Full project and exact-commit CI
results are retained in the pull request's checks.

Assessment independence: A and B ran separately, and A completed before the parent
received B findings. The Impeccable detector and target-slug helper were unavailable
with exit 127; no deterministic scan, storage snapshot/trend or browser overlay
is claimed. The manual browser inspection is the fallback evidence. No overlay
server was started. Both parent-owned Storybook servers on ports 6006 and 6010 were stopped. Before screenshots are retained in the task's temporary evidence
folders; they are not durable release artifacts. No live repository/provider
mutation was performed during the assessment.
