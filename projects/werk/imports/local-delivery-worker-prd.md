---
document_type: product_requirements_document
document_id: PRD-LDW-001
product: Local Delivery Worker
version: 0.1
status: Draft for product review
created: 2026-10-20
updated: 2026-10-20
language: en
---

# Product Requirements Document: Local Delivery Worker

## Document control

| Field | Value |
| --- | --- |
| Working product name | Local Delivery Worker |
| Document ID | PRD-LDW-001 |
| Version | 0.1 |
| Status | Draft for product review |
| Date | 20 October 2026 |
| Source | The product concept developed in this conversation |
| Intended readers | Product owner, requirements engineer, UX designer, solution architect, developers, and testers |
| Product owner | To be assigned |
| Scope of this document | Product behaviour, functional and quality requirements, user journeys, constraints, release scope, and acceptance |

This PRD translates the concept into proposed requirements. It does not claim that the product has been implemented or that release dates, budgets, technology choices, or provider eligibility have been approved. “Local Delivery Worker” is a working title.

**Requirement language:** MUST indicates a required behaviour for the stated release; SHOULD indicates a preferred behaviour with a documented reason required for deviation; MAY indicates an optional capability. A requirement's release field determines when it applies. R2 requirements remain part of the target product scope even though the first implementation milestone is smaller.

**Priorities:** Must = required to accept the stated release; Should = valuable and expected unless explicitly deferred; Could = optional enhancement. Acceptance criteria describe observable outcomes. Performance targets are proposed acceptance targets, not measured results.

## Contents

1. [Executive summary](#1-executive-summary)
2. [Problem, opportunity, and goals](#2-problem-opportunity-and-goals)
3. [Users and jobs to be done](#3-users-and-jobs-to-be-done)
4. [Product principles](#4-product-principles)
5. [Scope and release strategy](#5-scope-and-release-strategy)
6. [Product vocabulary and information model](#6-product-vocabulary-and-information-model)
7. [User journeys](#7-user-journeys)
8. [Lifecycle and operating rules](#8-lifecycle-and-operating-rules)
9. [Functional requirements](#9-functional-requirements)
10. [Quality requirements](#10-quality-requirements)
11. [Markdown request contract](#11-markdown-request-contract)
12. [Quality gates and evidence](#12-quality-gates-and-evidence)
13. [Git delivery and review package](#13-git-delivery-and-review-package)
14. [Web interface requirements](#14-web-interface-requirements)
15. [Provider integration requirements and constraints](#15-provider-integration-requirements-and-constraints)
16. [Configuration and system boundaries](#16-configuration-and-system-boundaries)
17. [Product success measures](#17-product-success-measures)
18. [Release acceptance scenarios](#18-release-acceptance-scenarios)
19. [Dependencies, risks, and assumptions](#19-dependencies-risks-and-assumptions)
20. [Decisions and open questions](#20-decisions-and-open-questions)
21. [Release exit criteria](#21-release-exit-criteria)
22. [Sources](#22-sources)

## 1. Executive summary

Local Delivery Worker is a persistent application running on a user's machine. It watches a configurable folder inside a Git-backed project, ingests submitted Markdown requests, evaluates their readiness, coordinates implementation through supported AI coding tools, verifies the resulting changes, and prepares a review package.

The worker owns the delivery process. Claude Code, Codex, and Cursor are interchangeable execution tools within that process, subject to their supported capabilities and authentication options. A successful agent invocation is an execution event; completion of the requested work requires the configured evidence and review decisions.

The primary interaction model is file-based. The user expresses intent and answers questions in a Markdown request. The worker maintains a designated section with status, questions, decisions, verification findings, and links to delivery results. Git branches and commits record implementation changes. A local web interface makes configuration, monitoring, logging, and review convenient.

The worker adopts useful concepts from game AI: observable world state, a typed working context or blackboard, explicit preconditions, reusable behaviours, priorities, interruption, and bounded reactions. A durable lifecycle records what has happened, a behaviour tree selects the next action, and a scheduler allocates execution capacity.

**Product promise:** Write a request in your project, let the worker manage the delivery process, and review a documented Git change.

**Autonomous completion boundary:** The worker prepares a result that is ready for review. Human acceptance remains a distinct action. Merge and release are separate delivery facts unless a project explicitly includes them in its completion policy.

## 2. Problem, opportunity, and goals

### 2.1 Problem statement

Working with coding agents currently requires the user to perform much of the surrounding delivery coordination: describe work, decide whether requirements are sufficient, select a tool, prepare a workspace, monitor execution, interpret failures, run checks, retain context across interruptions, and prepare a reviewable result.

The product addresses this coordination burden for users who already manage their work in a local Git repository and prefer durable, editable project files. This is a product hypothesis derived from the requested workflow; no market-size or productivity improvement is asserted.

### 2.2 Goals

| ID | Goal | Desired outcome |
| --- | --- | --- |
| G-01 | Make Markdown requests actionable | A user can submit work from the project folder and receive an understandable next action or review result. |
| G-02 | Own the complete request lifecycle | Readiness, implementation, verification, recovery, and handover are consistently coordinated. |
| G-03 | Make completion assessable | Every mandatory completion criterion has evidence or an explicit unresolved result. |
| G-04 | Preserve local project control | The user's unrelated work, staging state, credentials, and project boundaries remain protected. |
| G-05 | Support provider choice | The target product supports Claude Code, Codex, and Cursor through supported integrations. |
| G-06 | Make unattended work observable and recoverable | Users can understand the current state and recover after interruption without silently duplicating consequential actions. |
| G-07 | Reduce manual orchestration | Users spend their attention on requirements, meaningful decisions, and review rather than supervising individual model calls. |

### 2.3 Non-goals

The initial product does not provide a general-purpose IDE, a replacement Git host, autonomous production deployment, an enterprise multi-user permission platform, or a model-hosting service. It does not promise that any subscription can be used as a generic model API or that provider usage is unlimited.

A visual behaviour-tree editor, self-generated executable behaviours, distributed worker fleets, advanced planning algorithms, and automatic merging are outside R1. Direct model APIs are a separate future execution capability; they are not required to reproduce the tool loop already supplied by supported coding-agent runtimes.

## 3. Users and jobs to be done

The following are responsibilities. One local user may perform all of them in R1.

| Role | Need | Main actions |
| --- | --- | --- |
| Request author / product owner | Turn a desired outcome into deliverable work | Write requests, set priority, answer questions, clarify acceptance criteria. |
| Developer / maintainer | Receive changes that fit the repository and are easy to inspect | Configure project guidance and checks, inspect diffs, investigate findings. |
| Reviewer | Decide whether the requested result is acceptable | Inspect evidence, perform manual checks, request changes, accept a candidate. |
| Local operator | Keep execution predictable and available | Configure providers and limits, inspect health, pause, cancel, retry, and recover. |

### 3.1 Jobs to be done

- **JTBD-01:** When I identify a feature or defect, I want to describe it in a project file so that it can enter a repeatable delivery workflow without moving into another task-management system.
- **JTBD-02:** When my request is incomplete, I want specific questions and suggested interpretations so that I can make the missing decisions quickly.
- **JTBD-03:** When an agent works on my project, I want bounded execution and visible progress so that I can continue my own work confidently.
- **JTBD-04:** When a run stops or the machine restarts, I want the worker to retain what it knows so that I can recover without reconstructing the session manually.
- **JTBD-05:** When implementation is finished, I want a change set and evidence against my criteria so that I can make a review decision.
- **JTBD-06:** When I change coding tools or authentication options, I want the same request workflow to remain usable.

## 4. Product principles

1. **The worker owns process state.** Providers contribute execution and analysis; lifecycle transitions follow explicit rules.
2. **Markdown is the user's durable working surface.** Requests remain readable and editable with ordinary tools, including an editor or Obsidian.
3. **Evidence supports completion.** Provider assertions and process exit codes are not substitutes for required checks.
4. **Automation follows configured authority.** Permissions and budgets are established through trusted configuration and deliberate user actions.
5. **Human input is focused.** Ask when missing information materially affects scope, behaviour, cost, or authority; record permitted low-impact assumptions.
6. **Partial work remains inspectable.** Failures, cancellation, and interruptions preserve useful changes and diagnostics.
7. **State is explainable.** Every wait, retry, transition, and handover identifies its reason and next action.
8. **Capabilities are explicit.** Unsupported provider behaviour is visible; the product does not silently emulate stronger guarantees.
9. **The local user retains control.** Work continues independently of the web view, with clear controls for intake and active execution.
10. **Extension preserves the contract.** New providers and behaviours must retain request identity, evidence rules, and lifecycle guarantees.

## 5. Scope and release strategy

### 5.1 Release definitions

| Release | Outcome | Scope |
| --- | --- | --- |
| R1 — Complete local workflow | Demonstrate one recoverable request-to-review journey | One configured repository, one supported adapter, one active implementation, basic web interface, Markdown communication, local Git delivery. |
| R2 — Provider choice | Deliver the requested three-tool capability | Claude Code, Codex, and Cursor adapters; project and request provider selection; documented capability differences; optional separate review provider. |
| R3 — Coordinated delivery | Extend capacity and integration | Multiple repositories, concurrent work, richer dependency planning, optional remote PR creation, advanced routing, reusable behaviour libraries. |

R1 is a vertical slice. R2 support for all three named tools is part of the intended product, not an optional substitute for the initial request. Release labels express sequencing and contain no delivery-date commitment.

### 5.2 Scope matrix

| Capability | R1 | R2 | R3 / later |
| --- | --- | --- | --- |
| Configurable Markdown intake folder | Required | Retained | Multiple projects |
| Draft and explicit submission | Required | Retained | Retained |
| Readiness checks and clarification | Required | Retained | Richer profiles |
| Durable lifecycle and recovery | Required | Retained | Fleet coordination |
| Authored behaviour profile | Required | Additional profiles | Optional visual authoring |
| One supported coding-agent adapter | Required | All three named tools | Additional providers |
| Supported account/API connection modes | For the selected adapter | For each adapter, subject to provider support | Additional official integrations |
| Worktree and branch per task | Required | Retained | Parallel work and integration checks |
| Relevant deterministic checks and bounded repair | Required | Retained | Expanded check packs |
| Local review note and commits | Required | Retained | Optional remote publication |
| Web configuration, logs, and monitoring | Required | Expanded provider controls | Fleet views |
| Basic dependency blocking | Required | Retained | Dependency graph planning |
| Per-request provider override | Single provider only | Required | Advanced routing |
| Separate AI reviewer | Optional within selected provider | Supported as a configurable profile | Extended review policies |
| Several active implementations per repository | Out of scope | Out of scope | Planned extension |
| Direct raw model API tool loop | Out of scope | Out of scope | Separate capability |
| Automatic merge or deployment | Out of scope | Out of scope | Separate future decision |

### 5.3 Initial operating assumptions

- The user has a local Git-backed project and authority to configure its worker.
- The selected provider runtime and the project's development tools are installed or installed through an explicit setup action.
- R1 runs under one local user account; author, operator, and reviewer responsibilities do not require separate product accounts.
- Internet access may be required by the selected provider. Local orchestration does not imply local inference.
- The first supported operating-system environment must be declared before R1 implementation and tested as a release gate. Additional platforms must be listed as supported, unsupported, or experimental.

## 6. Product vocabulary and information model

| Entity | Definition | Required relationships |
| --- | --- | --- |
| Project | A registered local repository and its effective worker configuration | Owns requests, policies, provider choices, and runs. |
| Request | A user-authored desired outcome with a stable identity | Has revisions and may have several runs. |
| Request revision | An immutable snapshot of semantic requirement content and relevant answers | Identifies the exact intent evaluated and executed. |
| Run | An attempt to process one revision against a repository baseline and policy set | Owns steps, invocations, evidence, and a result. |
| Step | A bounded activity within a run | Has preconditions, execution status, and outcomes. |
| Invocation | A provider process, SDK run, or model interaction | Has worker identity and, where available, provider-session identity. |
| Agent runtime | A tool such as Codex, Claude Code, or Cursor that performs an agent/tool loop | Exposes supported execution capabilities through an adapter. |
| Model | The inference model selected by or for a runtime | Recorded when the runtime reports it. |
| Execution profile | Provider, authentication mode, permissions, tools, and limits for an assignment | Selected for a run or step within project policy. |
| Behaviour profile | A supported policy for selecting and sequencing actions | Versioned and associated with a run. |
| Gate decision | Evaluation of a Definition of Ready or Definition of Done | References checks, findings, and evidence. |
| Evidence | An observation or assessment tied to exact inputs | References a request revision, code revision, check, and artifact or log. |
| Review package | Information required to review the candidate result | References the request, run, branch, candidate, and evidence. |

Provider-session identity must not replace worker request/run identity. Resuming a vendor session does not by itself establish that the current workspace or requirements are still compatible.

## 7. User journeys

### 7.1 Configure a project

1. The user selects a repository and intake folder.
2. The worker checks Git access and displays the selected baseline policy.
3. The user selects an available execution profile and completes the provider's supported authentication flow if necessary.
4. The user selects readiness and completion profiles, permitted actions, and execution limits.
5. The worker displays configuration validity and any missing capability.
6. The user enables intake. Closing the web interface does not stop the worker.

**Outcome:** The project is ready to accept submitted requests, with the effective execution and delivery policy visible.

### 7.2 Submit a ready request

1. The user creates a Markdown request from a template.
2. The request remains a draft while it is being written.
3. The user changes its intent to submit.
4. The worker registers the revision once, evaluates readiness, and records the result.
5. The worker prepares a plan and isolated Git workspace, delegates implementation, and gathers verification evidence.
6. The worker creates a local review package and marks the request as in review.
7. The user reviews the candidate and accepts it or requests changes.

**Outcome:** A reviewable change is linked to its original requirements and verification results.

### 7.3 Resolve incomplete requirements

1. Readiness assessment identifies a material ambiguity or missing prerequisite.
2. The worker writes stable, answerable questions and identifies the blocked activity.
3. The user answers in the request file or through the web interface.
4. The worker captures the updated requirement revision and reassesses the affected gate.
5. Work begins when mandatory readiness conditions are satisfied.

**Outcome:** The user supplies the necessary decision without reconstructing the request in a chat session.

### 7.4 Recover after interruption

1. A provider fails, the daemon restarts, or the machine sleeps during work.
2. On recovery, the worker displays the last known state and reconciles any uncertain invocation.
3. Existing edits, commits, session references, and evidence remain available.
4. The worker resumes a supported operation, creates a new invocation from a known checkpoint, or asks for a concrete recovery decision.

**Outcome:** The user can determine what happened and what is safe to do next; an uncertain action is not blindly repeated.

### 7.5 Review and request changes

1. The user opens the review package and verifies the identified candidate.
2. The user performs remaining manual checks and records findings.
3. Acceptance is associated with that candidate and request revision.
4. Requested changes become a new revision and run with retained history.
5. If a new candidate is proposed, affected evidence becomes stale. Earlier acceptance remains a historical decision about its recorded candidate and does not accept the new candidate.

**Outcome:** Review is traceable and applies to a concrete change set.

## 8. Lifecycle and operating rules

### 8.1 Request lifecycle

| State | Meaning | Typical next state |
| --- | --- | --- |
| draft | The request is being authored and has not authorized execution | submitted, cancelled |
| submitted | The request is registered and awaiting or undergoing readiness assessment | ready, cancelled |
| ready | Required readiness conditions are satisfied for the current revision | in_progress, submitted, cancelled |
| in_progress | Delivery is active or awaiting an execution prerequisite | in_review, submitted, cancelled |
| in_review | A candidate and review package are available and required automated gates are satisfied | done, in_progress, submitted, cancelled |
| done | The configured human acceptance/completion policy is satisfied for the recorded candidate | submitted only through explicit reopening |
| cancelled | The request is closed without acceptance; retained work remains inspectable | submitted only through explicit reopening |

Readiness findings, dependency waits, failures, and provider limits are represented through run status and reason fields, rather than an unbounded set of request-state combinations.

### 8.2 Run status and phase

Run status values are queued, running, waiting, pause_pending, paused, interrupting, interrupted, reconciling, outcome_unknown, failed, completed, and cancelled. A reason identifies the missing information, capability, authorization, provider availability, failed gate, or unresolved operation.

Phases are assessing, planning, preparing, implementing, verifying, repairing, and packaging. A phase describes the current activity; it does not imply that its gate has passed.

An operation whose outcome is unknown must enter reconciliation before retry. “Cancellation pending” is presented while relevant execution is still being stopped. Cancellation remains pending while a relevant local process or remote operation is known to continue or its stopping outcome is unknown. Cancellation is complete only after relevant execution has ceased. Continuing operations remain explicitly visible. An interrupted run cannot dispatch further task work until an explicit resume or retry action is accepted.

### 8.3 Transition rules

- Only explicit submission starts the delivery workflow for a draft.
- Required DoR checks must pass before implementation begins.
- A material requirement edit triggers reassessment. The active run remains bound to its earlier revision until it is safely stopped, reconciled, or superseded.
- Entering in_review requires a current candidate and complete review package. Every mandatory automated criterion must have current passing evidence, a permitted not-applicable result, or an authorized exemption scoped to that criterion and revision. An unexempted fail, unknown, or stale result prevents review-ready. Human checks may remain explicitly pending.
- If code or verification inputs change during in_review while requirements remain ready, the request returns to in_progress with phase verifying or repairing. If requirements need reassessment, it returns to submitted. The UI immediately withdraws review-ready status.
- An agent cannot assign human acceptance to its own result.
- Acceptance transitions a request to done only when every mandatory human criterion has a recorded passing result or authorized exemption. If acceptance itself is a permitted attestation, the interface and Markdown contract identify the criteria it attests to; other pending checks are not implicitly passed.
- R1 uses human acceptance as the completion policy. A later project policy may additionally require confirmed merge.
- A local note, a successful push, a created PR, a merge, and a release are distinct facts.
- Editing a done or cancelled request does not restart execution, even if its stored intent remains submit. A distinct explicit reopen command creates a new eligible revision and retains prior runs, evidence, and decisions.
- A user editing generated status text cannot manufacture a verified gate result; the worker's durable record governs its reported execution facts.

### 8.4 Behaviour and scheduling rules

The durable lifecycle constrains valid transitions. The behaviour tree selects the next permitted action. The scheduler chooses which eligible request can consume available capacity. This separation is a product constraint; the detailed implementation belongs in the system design.

The default behaviour prioritizes cancellation, reconciliation, changed inputs, unmet prerequisites, readiness, planning, implementation, verification, bounded repair, and handover. Long-running actions must be started once and observed through their recorded identity. Behaviour evaluation must not repeatedly launch an active invocation.

R1 permits one active implementation per project. Submitted requests may be queued. A bare dependency ID is satisfied when the referenced request is done and its accepted result is available in the selected baseline wherever that result includes code. The dependent run records the accepted predecessor revision and candidate used to establish satisfaction. Uncertain incorporation blocks dispatch pending resolution. A predecessor being accepted is insufficient if its required changes are absent from that baseline.

## 9. Functional requirements

### E-01 — Project setup and configuration

**Epic outcome:** The local operator can establish an understandable execution environment before requests are processed.

| ID | Requirement | Acceptance criteria | Release / priority |
| --- | --- | --- | --- |
| FR-SET-001 | The product MUST register a local Git repository and configurable request directory. | Setup identifies the repository and canonical intake location; invalid or inaccessible locations produce an actionable error; execution remains disabled until essential setup is valid. | R1 / Must |
| FR-SET-002 | The product MUST validate and display effective project configuration. | The user can see the selected baseline, quality profiles, execution profile, permitted Git actions, limits, and intake state before enabling work. | R1 / Must |
| FR-SET-003 | The product MUST retain the configuration and policy versions applicable to each run. | A configuration edit affects future work by default; active runs retain their recorded settings unless an explicit supported transition applies the change. Restrictive policy revocation is enforced promptly. | R1 / Must |
| FR-SET-004 | The product MUST identify prerequisites and supported operating environments. | Diagnostics distinguish missing Git, missing provider runtime, missing project tools, unsupported platform, and invalid credentials. Installation or upgrade occurs only through an explicit setup action. | R1 / Must |

### E-02 — Request intake and revision management

**Epic outcome:** A request enters the workflow once, with a stable identity and a clear record of the intent being executed.

| ID | Requirement | Acceptance criteria | Release / priority |
| --- | --- | --- | --- |
| FR-INT-001 | The worker MUST discover matching Markdown files through watching and reconciliation. | Stable saves appear in the queue; a startup scan discovers work created while the worker was stopped; repeated filesystem events do not create duplicate runs. | R1 / Must |
| FR-INT-002 | The worker MUST distinguish drafting from submission. | A draft does not invoke an implementation agent. Changing the supported submission field to submit registers one eligible revision. | R1 / Must |
| FR-INT-003 | Requests MUST have stable identities independent of filenames. | Renaming within intake preserves history. Duplicate IDs prevent ambiguous execution and identify the conflicting files. Templates and UI creation supply valid IDs. | R1 / Must |
| FR-INT-004 | The worker MUST validate the request format without destroying invalid content. | Malformed frontmatter, unsupported schema, missing required identifiers, and merge markers produce visible findings; source text is retained for correction. | R1 / Must |
| FR-INT-005 | The worker MUST retain semantic request revisions and detect material edits. | Every run identifies its input revision. Material edits to a nonterminal request trigger reassessment; terminal requests require explicit reopening. Generated status updates do not retrigger implementation. | R1 / Must |
| FR-INT-006 | The worker MUST support priority and basic dependency references. | The queue reflects priority. Unknown dependencies, dependency cycles, and unmet baseline prerequisites block dispatch with a specific reason. | R1 / Must |
| FR-INT-007 | The worker MUST handle missing or moved source files explicitly. | A move within intake preserves identity. A missing active source produces a visible source-missing condition and blocks further new task actions until reconciled or cancelled. | R1 / Must |

### E-03 — Readiness and clarification

**Epic outcome:** The author receives focused questions and the worker starts only work that can be meaningfully executed and verified.

| ID | Requirement | Acceptance criteria | Release / priority |
| --- | --- | --- | --- |
| FR-RDY-001 | The worker MUST apply the selected Definition of Ready to the current revision. | The result lists each mandatory condition, its outcome, and supporting reason. Implementation cannot begin while a required condition is failed or unresolved. | R1 / Must |
| FR-RDY-002 | The worker MUST support proportionate quality profiles. | At minimum, a general feature profile and a lightweight change profile can express different required inputs without changing the request lifecycle. | R1 / Must |
| FR-RDY-003 | The worker MUST ask stable, actionable clarification questions. | Each blocking question has an ID, states the needed decision and its impact, and is visible in Markdown and the UI. | R1 / Must |
| FR-RDY-004 | The worker MUST ingest answers and reassess readiness. | Answering a question through either supported surface creates a traceable revision and reevaluates affected conditions without discarding earlier history. | R1 / Must |
| FR-RDY-005 | The worker SHOULD propose interpretations and record permitted assumptions. | Proposed wording remains distinguishable from accepted requirements. A blocking answer is never invented; low-impact assumptions follow the configured policy and remain visible. | R1 / Should |
| FR-RDY-006 | The worker MUST check execution prerequisites before dispatch. | Missing tools, unavailable permissions, unresolved dependencies, or incompatible provider capabilities produce a specific waiting/blocked reason. | R1 / Must |

### E-04 — Lifecycle, behaviour, and execution control

**Epic outcome:** The worker makes observable, bounded decisions and can be controlled throughout its lifecycle.

| ID | Requirement | Acceptance criteria | Release / priority |
| --- | --- | --- | --- |
| FR-FLW-001 | The worker MUST enforce the lifecycle and run-state rules. | Invalid transitions are rejected with a reason; state changes record request, revision, run, timestamp, and triggering event. | R1 / Must |
| FR-FLW-002 | The worker MUST expose its current behaviour and decision reason. | The monitor identifies the active phase/behaviour, its prerequisite or wait condition, and the next expected event without requiring raw-log interpretation. | R1 / Must |
| FR-FLW-003 | The worker MUST respect concurrency and action identity. | R1 has at most one active implementation per project; observing a running behaviour does not start a second invocation; multiple daemon instances cannot claim the same execution ownership. | R1 / Must |
| FR-FLW-004 | The user MUST be able to pause intake and pause after the current bounded step. | Intake pause prevents additional request runs from starting; already active runs may continue permitted steps. Step pause prevents the next step of the selected run and remains pending until the current step boundary is reached. | R1 / Must |
| FR-FLW-005 | The user MUST be able to interrupt execution or cancel a request. | New task actions stop; the UI reports pending interruption until the execution outcome is established; partial changes remain inspectable; unavailable stop capabilities are disclosed. | R1 / Must |
| FR-FLW-006 | The worker MUST apply bounded execution, retries, and repairs. | The current limits and attempt counts are visible. Exhaustion preserves work and produces an actionable outcome; retries cannot bypass a missing answer, denied permission, or mandatory gate. | R1 / Must |
| FR-FLW-007 | The worker MUST reconcile interrupted or uncertain operations before repeating them. | Restart distinguishes failed, interrupted, and unknown outcomes. Existing invocation, workspace, commit, and publication records are inspected before another consequential attempt. | R1 / Must |
| FR-FLW-008 | The worker MUST prepare a bounded assignment before delegating work. | The assignment identifies its objective, request revision, workspace, criteria, relevant guidance, permitted actions, limits, and expected result. | R1 / Must |

### E-05 — Provider connections and delegation

**Epic outcome:** Users can execute work through supported tools while understanding the active capabilities, authority, and usage mode.

| ID | Requirement | Acceptance criteria | Release / priority |
| --- | --- | --- | --- |
| FR-PRV-001 | The product MUST expose provider setup and capability diagnostics. | The interface shows runtime name, installed/integration version, connection state, authentication mode, and relevant supported or unavailable capabilities. | R1 / Must |
| FR-PRV-002 | The product MUST support the authentication modes explicitly declared by the selected adapter, including an API-credential path and official account/subscription path where available for its chosen interface. | Supported account login uses the vendor flow; API credentials use the configured credential mechanism; unsupported combinations are rejected or clearly marked unavailable before dispatch where detectable. Additional enterprise/cloud-provider authentication modes are separately declared. | R1 / Must |
| FR-PRV-003 | The worker MUST preserve explicit authentication and billing choices. | A failed subscription-backed connection does not silently switch to API billing. Usage is labelled measured, estimated, or unavailable; unavailable cost is not displayed as zero. | R1 / Must |
| FR-PRV-004 | The worker MUST normalize provider outcomes into its own lifecycle. | Running, completed, failed, interrupted, authentication-required, rate-limited, and approval-required outcomes are distinguishable. Provider completion triggers worker evaluation rather than request acceptance. | R1 / Must |
| FR-PRV-005 | The worker MUST enforce the selected execution boundary using supported runtime controls. | Missing required isolation or approval capability blocks dispatch or requires an explicit permitted profile change. Prompt text cannot silently enlarge the permitted workspace or actions. | R1 / Must |
| FR-PRV-006 | The target product MUST support Claude Code, Codex, and Cursor. | Each adapter completes the common R2 acceptance suite, with its supported authentication modes and capability limitations documented. | R2 / Must |
| FR-PRV-007 | Users MUST be able to choose a project default and an allowed request override. | The effective provider/profile is visible before dispatch. Overrides remain within project authority; provider/model/session identities are recorded when available. | R2 / Must |
| FR-PRV-008 | The product SHOULD support a separate review profile. | Review findings retain provenance and feed the same repair and evidence rules; a second model's approval does not replace deterministic checks. | R2 / Should |
| FR-PRV-009 | The product MAY support configured fallback and cross-provider handoff. | Only authorized profiles are considered; the handoff contains the request revision, checkpoint, changes, and findings; provider-specific sessions are not represented as portable. | R3 / Could |

### E-06 — Git workspace and change ownership

**Epic outcome:** Delivery changes are isolated, attributable, and reviewable while the user's working state remains intact.

| ID | Requirement | Acceptance criteria | Release / priority |
| --- | --- | --- | --- |
| FR-GIT-001 | Each implementation MUST use a worker-owned branch and workspace rooted at an explicit baseline commit. | The branch, workspace, and baseline are visible and associated with the run; source changes in the user's checkout are not silently incorporated. | R1 / Must |
| FR-GIT-002 | The worker MUST preserve unrelated user work and staging state. | Unrelated staged, unstaged, and untracked files remain intact. Worker commits contain intended task changes; live request communication edits are limited to their designated region. | R1 / Must |
| FR-GIT-003 | The worker MUST record meaningful implementation checkpoints. | Commits are linked to the request/run, accurately describe their changes, and can be inspected after interruption or cancellation. | R1 / Must |
| FR-GIT-004 | The worker MUST inspect the resulting diff and detect scope or baseline conflicts. | Unexpected changes, merge conflicts, or missing prerequisite code produce findings. Integration onto a different baseline causes affected checks to be rerun. | R1 / Must |
| FR-GIT-005 | Workspace cleanup MUST preserve unaccepted work and evidence. | Dirty or unresolved workspaces are retained by default; removal identifies what will be removed and follows an explicit retention or user cleanup action. | R1 / Must |
| FR-GIT-006 | Remote push and PR creation MAY be provided as separate delivery actions. | Each action follows configured authorization and reports its actual outcome; retry reconciles prior publication; a local note is never shown as a created PR. | R3 / Could |

### E-07 — Verification and Definition of Done

**Epic outcome:** The user can assess the result against criteria using current, attributable evidence.

| ID | Requirement | Acceptance criteria | Release / priority |
| --- | --- | --- | --- |
| FR-VER-001 | The worker MUST evaluate the configured DoD and request acceptance criteria. | Every mandatory criterion has a result and evidence or an explicit unresolved outcome. Each mandatory automated criterion needs current passing evidence, a permitted not-applicable result, or an authorized revision-specific exemption; unexempted failures, unknowns, and stale results prevent review-ready. | R1 / Must |
| FR-VER-002 | The worker MUST execute configured deterministic checks and retain their results. | Check identity, command or evaluator, environment, exit/outcome, time, and evidence reference are recorded. A provider's narrative cannot fabricate a passing tool result. | R1 / Must |
| FR-VER-003 | Evidence MUST be bound to the evaluated request and code revisions. | Changing the requirements, relevant code, check definition, or baseline marks affected evidence stale; the worker revalidates before returning to review-ready. | R1 / Must |
| FR-VER-004 | Gate definitions MUST retain their approved meaning during execution. | An implementing agent cannot silently weaken a mandatory gate. Test or policy changes are visible; exemptions are explicit, attributable, scoped, and retained in review. | R1 / Must |
| FR-VER-005 | The worker MUST distinguish failing, unknown, not applicable, and human-pending results. | Missing tools, timeouts, skipped checks, and unavailable environments cannot appear as passing checks. Mandatory exceptions follow project authority and remain disclosed. | R1 / Must |
| FR-VER-006 | Verification failures MUST feed a bounded repair workflow. | Repairs reference the failed findings, preserve attempt history, and generate fresh evidence. Exhaustion produces an incomplete result with next actions. | R1 / Must |
| FR-VER-007 | The product SHOULD distinguish pre-existing failures from regressions where feasible. | Baseline observations are recorded separately; a pre-existing failure is not automatically exempted from a mandatory gate. | R1 / Should |

### E-08 — Markdown communication and review

**Epic outcome:** Users can collaborate through the request file and review a complete account of the delivered change.

| ID | Requirement | Acceptance criteria | Release / priority |
| --- | --- | --- | --- |
| FR-COM-001 | The worker MUST preserve user-owned request content. | Worker updates target designated regions; a conflicting edit preserves both relevant versions and exposes a reconciliation action instead of replacing newer user text. | R1 / Must |
| FR-COM-002 | The worker MUST publish meaningful milestones and actionable blockers. | Status, questions, key assumptions, verification findings, and delivery references appear in the file; detailed token/event streams remain in logs. | R1 / Must |
| FR-COM-003 | Every review-ready result MUST include a Markdown review package. | The package contains scope, candidate identification, changes, criterion evidence, checks, limitations, manual review steps, and a proposed PR title/body. | R1 / Must |
| FR-COM-004 | The user MUST be able to accept or request changes against an identified candidate. | Acceptance records request revision and candidate identity and requires recorded outcomes or authorized exemptions for mandatory human criteria. Feedback reopens work with retained history. Stale acceptance is rejected with the current candidate shown. | R1 / Must |
| FR-COM-005 | Markdown and UI actions MUST share the same application rules. | Equivalent supported actions produce the same lifecycle and audit outcome; editing generated status cannot bypass a gate. | R1 / Must |
| FR-COM-006 | Explicit Markdown control and review commands MUST have stable, once-consumed identities. | Repeated saves of the same command do not repeat its action. Reusing an ID with a different payload is rejected. A completed/cancelled request requires a distinct reopen command before further execution. | R1 / Must |

### E-09 — Web configuration, logging, and monitoring

**Epic outcome:** The user understands what is happening and can act without reading raw provider output.

| ID | Requirement | Acceptance criteria | Release / priority |
| --- | --- | --- | --- |
| FR-UI-001 | The UI MUST provide an overview of active, queued, blocked, and review-ready work. | Each active item identifies phase, provider, elapsed time, current reason, and next user action where applicable; counts agree with request details. | R1 / Must |
| FR-UI-002 | The UI MUST provide request details and review access. | Users can inspect request revisions, questions, plan, activity, changes, verification, and review material; supported answers and decisions write back through the request contract. | R1 / Must |
| FR-UI-003 | The UI MUST provide an inspectable run timeline and logs. | Events are correlated to request/run/step, ordered, filterable, and distinguish provider output from worker decisions and verification results. | R1 / Must |
| FR-UI-004 | The UI MUST expose configuration and execution controls with precise outcomes. | Provider setup, policy selection, intake pause, step pause, interruption, cancellation, retry, and recovery actions show availability and pending/completed results. | R1 / Must |
| FR-UI-005 | Closing or reconnecting the UI MUST preserve execution continuity. | The daemon continues according to policy; reopening reconstructs current state and relevant missed activity without duplicating commands. | R1 / Must |
| FR-UI-006 | The UI SHOULD provide a read-only behaviour inspector. | The active behaviour, inspected conditions, selection reason, wait condition, and retry/deadline settings are visible. | R1 / Should |

### E-10 — Operational control and extensibility

**Epic outcome:** The worker remains useful after failures and can grow without changing its fundamental contract.

| ID | Requirement | Acceptance criteria | Release / priority |
| --- | --- | --- | --- |
| FR-OPS-001 | Execution state MUST survive process restart. | Request/run identities, pinned inputs, active operations, checkpoints, and evidence are recovered or explicitly reported as uncertain; unknown operations are reconciled before retry. | R1 / Must |
| FR-OPS-002 | The product MUST retain and redact operational information according to policy. | Credentials are excluded from ordinary logs and exports; retention settings distinguish temporary logs from accepted delivery evidence and unaccepted work. | R1 / Must |
| FR-OPS-003 | The product MUST expose budget, timeout, and capacity decisions. | Before dispatch, unavailable capacity or exhausted limits produce a reason; observed usage and enforcement limits are shown honestly when provider metering is incomplete. | R1 / Must |
| FR-OPS-004 | The product SHOULD allow additional adapters and checks without changing existing request identity or lifecycle semantics. | An extension declares capabilities and passes the relevant contract acceptance suite; existing requests remain readable and valid. | R2 / Should |
| FR-OPS-005 | The product MAY support multiple repositories and concurrent requests. | Each run retains isolated ownership; dependency and integration verification prevents a branch's success from being treated as integrated project success. | R3 / Could |

## 10. Quality requirements

All quality requirements below are mandatory for their stated release unless explicitly revised through product review. The numeric targets are proposed for acceptance planning. Performance measurements use a declared reference environment of four CPU cores, 16 GB RAM, local SSD storage, and a repository with 1,000 request files averaging no more than 64 KB each. Provider inference, dependency installation, project builds, tests, and remote network latency are measured separately.

| ID | Quality requirement | Acceptance measure | Release |
| --- | --- | --- | --- |
| NFR-REL-001 | Durable state and recovery | The interruption suite covers assessment, dispatch, editing, verification, commit creation, and packaging. Each interruption recovers a truthful state with no lost committed checkpoint or blind replay of an uncertain side effect. | R1 |
| NFR-REL-002 | Request integrity | Concurrent-edit and malformed-file scenarios preserve user-authored content or an explicitly recoverable version. No silent overwrite is accepted. | R1 |
| NFR-REL-003 | Honest execution outcomes | All acceptance scenarios distinguish pending, completed, failed, and unknown operations. A completed UI action must agree with the durable operation result. | R1 |
| NFR-PERF-001 | Local intake responsiveness | A stable saved request appears with an intake status within 3 seconds at the 95th percentile in the reference environment. This excludes completion of semantic readiness analysis. | R1 |
| NFR-PERF-002 | Startup reconciliation | A scan of the reference request set completes within 10 seconds at the 95th percentile; slow or failed inputs are reported without making the entire interface unusable. | R1 |
| NFR-PERF-003 | Responsive monitoring | Locally available state changes appear in an open UI within 2 seconds at the 95th percentile. Log updates preserve keyboard focus, scroll position where appropriate, and active controls. | R1 |
| NFR-PERF-004 | Efficient waiting | Waiting for a user, provider, or deadline generates no repeated implementation dispatch and no model calls merely to poll an unchanged condition. Events and bounded reconciliation drive wake-up. | R1 |
| NFR-SEC-001 | Credential separation | Credentials do not appear in request files, Git commits, review packages, or ordinary logs. Credential access is limited to the configured integration path. | R1 |
| NFR-SEC-002 | Local control surface | The initial web service is accessible only through its declared local interface, validates command origin/session authority, and does not expose arbitrary shell execution through the UI. Remote access requires a separate supported configuration. | R1 |
| NFR-SEC-003 | Enforced execution authority | A request, repository instruction, plugin output, or model response cannot enlarge trusted permissions or modify the gate policy governing its own run. Missing enforcement produces a clear capability limitation. | R1 |
| NFR-USE-001 | Understandable state | In each blocked acceptance scenario, the primary request view identifies what is waiting, why, who can resolve it, and the next action. | R1 |
| NFR-ACC-001 | Accessible operation | All primary actions are keyboard reachable, focus is visible and retained, form errors identify the affected field, and status meaning is conveyed through text as well as colour. | R1 |
| NFR-OBS-001 | Traceable operations | Every lifecycle transition, invocation, check result, retry, and user decision can be traced to request/run identifiers and ordered timestamps. | R1 |
| NFR-COMP-001 | Portable project artifacts | Requests, configuration, and review notes are UTF-8 text with documented versioned schemas. The release declares supported platforms, filesystem behaviour, and provider versions. | R1 |
| NFR-MAINT-001 | Stable extension boundaries | Adding an adapter or check does not require changes to existing request identifiers, lifecycle meanings, or evidence validity rules. Adapter-specific limitations are testable. | R2 |
| NFR-DATA-001 | Explicit retention and recovery | Retention settings identify what can expire, what remains linked to accepted work, and how unaccepted changes are preserved. Loss of runtime state is reported as degraded recovery, never reconstructed as fabricated success. | R1 |

There is no fixed end-to-end feature completion-time guarantee. Request complexity, repository condition, provider behaviour, and project verification duration are material external factors.

## 11. Markdown request contract

### 11.1 Ownership and authority

The canonical intake file contains user-owned request content and one worker-managed region. The user owns the outcome, scope, criteria, references, answers, priority, dependencies, and explicit submission/review actions. The worker owns its status projection, questions, findings, and delivery references inside the managed region.

Execution facts are authoritative in the durable run record. The Markdown region is a readable projection of those facts. User edits to that region cannot attest to a successful check or accepted implementation. When a conflict is detected, the worker retains enough information to reconcile both versions and informs the user.

The implementation must define semantic hashing rules. Requirement content, relevant answers, and request-changes feedback accepted as new work input change the requirement revision. Worker-generated status, cosmetic formatting, scheduling priority, and command identity/acceptance metadata are handled separately so that they do not unnecessarily restart implementation. Conservative reassessment is preferred when a change cannot be classified safely, subject to the explicit reopening rule for terminal requests.

### 11.2 Proposed request fields

| Field | Owner | Meaning | Validation |
| --- | --- | --- | --- |
| schema | User/template | Request schema version | Supported version required. |
| id | User/template | Stable request identity | Unique within the registered project. |
| title | User | Short description of the desired work | Non-empty. |
| intent | User | draft or submit | Explicit submission required before execution. |
| priority | User | low, normal, high, or urgent | Default normal; subject to scheduler policy. |
| quality_profile | User | Named readiness/completion profile | Must resolve to an allowed project profile. |
| depends_on | User | Request IDs that must be satisfied | References must exist and be acyclic. |
| execution_profile | User, optional | Allowed provider/profile override | R2; must remain within project authority. |
| review | User, optional | Structured decision against a specific candidate | Candidate and requirement revision must match the offered result. |
| control | User, optional | Explicit control command with a unique command ID | Action, current state, and targeted run must be compatible. |

Markdown body sections include Outcome, Scope, Acceptance criteria, Boundaries, References, and Answers. Profiles determine which sections are mandatory. A defect profile may require reproduction steps and expected behaviour instead of feature-specific sections.

### 11.3 Example request template

This example illustrates the proposed contract. The fields and worker status shown here are not records of an executed task.

```markdown
---
schema: worker.request/v1
id: FR-0042
title: Export the filtered backlog as CSV
intent: draft
priority: normal
quality_profile: feature
depends_on: []
---

# Export the filtered backlog as CSV

## Outcome

As a Product Owner, I want to export the currently filtered
backlog so that I can share the selected work with stakeholders.

## Scope

Add an export action to the existing backlog view.
Include all matching items across pagination.
Use the current filtering rules.

## Acceptance criteria

- AC-01: The export contains only items matching the active filters.
- AC-02: The export includes ID, title, status, and owner.
- AC-03: Commas, quotes, and line breaks are escaped correctly.
- AC-04: An empty result shows a useful explanation.

## Boundaries

Preserve the existing filtering behaviour and persistence format.

## References

- docs/backlog-view.md

## Answers

<!-- Answer questions here using their IDs. -->

<!-- worker:begin -->
## Worker

Status: Draft
<!-- worker:end -->
```

### 11.4 Clarification contract

A question identifies its ID, the information required, why it matters, whether it blocks execution, and the affected criterion or decision. Answers belong in the user-owned Answers section or an equivalent web form that writes to that section.

```markdown
### Q-01

Exclude archived items, even if they match the other active filters.
```

Questions retain their history after being resolved. The worker must not repeatedly ask a resolved question unless the relevant input changes or a new contradiction appears.

### 11.5 Review decision contract

The web interface and Markdown must support the same candidate-specific review decision. The following proposed frontmatter fragment illustrates acceptance; the values are placeholders:

```yaml
review:
  command_id: CMD-0042-review-01
  decision: accept
  request_revision: "<reviewed request revision>"
  candidate_commit: "<reviewed Git commit>"
  human_checks: []
```

The worker records the local actor/context and time when the command is accepted. Missing or stale candidate references produce an actionable rejection. The empty human_checks list in the example is sufficient only when no required human criteria remain. Required manual outcomes must be recorded with criterion IDs and supporting notes, or covered by explicit authorized exemptions. Acceptance can attest to criteria only when the profile expressly defines that attestation and the decision identifies those criteria. The product must not interpret arbitrary prose such as “this looks fine” as an execution or publication command.

### 11.6 Explicit commands and replay protection

The initial transition from draft to submit is governed by intent and the registered request revision. Subsequent review/control actions use a unique command_id so that leaving the command in the file does not repeat it. The worker durably records consumption and displays its acknowledgement in the worker-managed region. Reusing a consumed command ID with changed content is rejected; a new intended action requires a new ID.

| Command location / action | Meaning | Required target |
| --- | --- | --- |
| review.decision: accept | Record a candidate-specific review decision subject to mandatory human criteria | Request revision and candidate commit |
| review.decision: request_changes | Return the request for reassessment with explicit review feedback | Reviewed revision/candidate and feedback |
| control.action: reopen | Reopen a done or cancelled request against the current user-authored content | Terminal request and a fresh command ID |
| control.action: pause_after_step | Prevent the selected active run's next step | Current run ID |
| control.action: interrupt | Stop active execution and retain an interrupted result | Current run ID |
| control.action: cancel | Close work after relevant execution has ceased | Current run ID when one exists |
| control.action: resume | Continue a compatible paused/interrupted run | Current run ID |
| control.action: retry | Start a permitted new attempt after the preceding outcome is known | Previous run ID |

Request-changes feedback is supplied as a structured feedback value or a clearly identified user-owned Review feedback section. Project-wide intake pause remains a project configuration/UI action. The UI emits equivalent validated application commands and cannot bypass replay or candidate checks.

```yaml
control:
  command_id: CMD-0042-reopen-01
  action: reopen
```

The run captures the newly submitted semantic revision when reopen is accepted. A stored intent of submit or an ordinary edit to a terminal request cannot trigger that action by itself.

## 12. Quality gates and evidence

### 12.1 Definition of Ready

The default feature profile checks the following conditions:

| Condition | Primary evaluation | Blocking behaviour |
| --- | --- | --- |
| The desired outcome is understandable | Structured assessment | Ask for the missing decision. |
| Acceptance criteria are observable | Assessment of criteria and verification approach | Propose measurable wording and request clarification where necessary. |
| Scope and boundaries are adequate | Structured assessment | Identify the ambiguity and its impact. |
| Required references are available | File/reference inspection | Identify the missing or inaccessible context. |
| Dependencies and baseline are suitable | Request and Git state | Wait for the prerequisite outcome and required code. |
| Tools, permissions, and provider capabilities are sufficient | Capability and configuration checks | Identify the missing capability or configuration action. |
| The task fits limits or an accepted decomposition | Scope and budget assessment | Request a scope/limit decision or propose decomposition. |

DoR is a set of conditions with reasons, not a single confidence score. Suggested refinements must remain visibly distinct from the user's accepted intent. Low-impact assumptions may be allowed through the project profile; material decisions remain explicit.

### 12.2 Definition of Done

The effective DoD combines the project profile, request-type profile, and request-specific criteria. A request can add requirements; it cannot silently remove mandatory project requirements.

| Evidence class | Examples | Treatment |
| --- | --- | --- |
| Deterministic technical checks | Build, type checks, lint, selected tests | Executed by the configured verification system; results retain command/evaluator provenance. |
| Acceptance evidence | Assertions, integration scenarios, screenshots, observed behaviour | Mapped to individual criteria. |
| Scope and quality review | Diff assessment, project conventions, relevant architecture checks | Findings retain assessor and input references. |
| Handover completeness | Change summary, limitations, manual steps, candidate identification | Required before review-ready. |
| Human review | Manual checks and candidate acceptance | Pending until recorded by an authorized user action. |

An LLM assessment can be evidence for a judgment-based criterion. It cannot replace the execution of a deterministic check that the policy requires. A separate reviewer model provides another assessment, not a guarantee of independent correctness.

### 12.3 Result semantics

- **pass:** The required observation supports the criterion.
- **fail:** The observation shows that the criterion is not satisfied.
- **unknown:** The required observation is absent, incomplete, timed out, or unavailable.
- **not_applicable:** The criterion does not apply, with an explicit permitted reason.
- **pending_human:** A required human assessment remains outstanding.
- **stale:** Earlier evidence no longer establishes the outcome for the current subject.

A configured exemption is a separate attributable decision, not a relabelled passing check. Its scope, reason, actor, and affected revision must be visible. Exemptions cannot authorize operations beyond the user's configured authority.

### 12.4 Evidence record

Every evidence record must identify the request and revision, run, candidate commit or content hash, check/criterion ID, definition version, evaluator/tool, environment, result, observation time, and a retained artifact or log reference. Usage or confidence estimates must be distinguishable from observed facts.

Before issuing review-ready status, the worker must establish that the candidate still matches its evidence. A rebase, repair, material requirement change, or relevant check-definition change invalidates affected results. Conservative full revalidation is acceptable in R1.

## 13. Git delivery and review package

### 13.1 Workspace policy

The worker uses an explicit committed baseline and its own task branch/worktree. Git's worktree facility supports multiple checked-out branches with separate per-worktree state while sharing repository data; process sandboxing and execution ownership are separate concerns.[^S1]

The user-facing intake file remains the canonical communication location. Its worker-managed region may change during a run. The worker must not stage or commit unrelated content from the user's active checkout to persist those updates. Implementation and request snapshots are recorded in the task workspace; live communication follows the configured project documentation workflow.

Uncommitted source dependencies must be surfaced before implementation. The product must explain whether the selected baseline contains the prerequisite code. Capturing an uncommitted request as an input snapshot is supported without assuming that all uncommitted source files are part of the task.

Agent-generated commits, if permitted by the execution profile, are still subject to worker reconciliation, scope inspection, and verification. Providers must not independently perform remote publication outside the configured delivery policy.

### 13.2 Candidate and report consistency

Verification targets a frozen candidate. The review report identifies that tested code state. The report can be stored outside the tested implementation workspace to avoid changing the subject of its own evidence. If packaging changes the delivered tree, the worker must retain the relationship to the tested state and rerun checks affected by the change.

Successful local checks do not prove that a later merge into a changed target branch is valid. Any supported integration/rebase action must reevaluate the affected checks.

### 13.3 Required review-package contents

| Section | Required information |
| --- | --- |
| Request | Request ID, title, canonical source, and requirement revision |
| Candidate | Run ID, baseline commit, branch, candidate commit, and diff reference |
| Implemented behaviour | What changed and how it addresses the requested outcome |
| Scope | Included work, excluded work, and material deviations |
| Acceptance evidence | Criterion-by-criterion results and evidence references |
| Verification | Commands/evaluators run, results, environment, and stale/unknown/exempted checks |
| Manual review | Outstanding human checks and instructions to inspect the result |
| Decisions | Material assumptions, design choices, and approved exceptions |
| Limitations | Known issues, incomplete work, and relevant follow-up |
| PR note | Suggested title and description with an accurate validation summary |
| Delivery status | Local-only package, pushed branch, created PR, or other actually observed state |

### 13.4 Suggested review-note structure

```markdown
# Review: <request ID> — <title>

## Requested outcome
<summary and requirement revision>

## Candidate
<run, baseline, branch, commit, and diff reference>

## Changes
<implemented behaviour and relevant decisions>

## Acceptance evidence
<criterion, result, evidence, and remaining human checks>

## Verification
<checks run, outcomes, environment, and exceptions>

## Review instructions
<how to inspect and exercise the change>

## Known limitations
<remaining issues or an explicit statement based on the recorded findings>

## Proposed pull request
<title and description>

## Delivery status
<actual local or remote delivery state>
```

## 14. Web interface requirements

### 14.1 Information architecture

| Screen | Main information | Main actions |
| --- | --- | --- |
| Overview | Active work, queue, waiting reasons, review-ready results, provider health | Open a request, pause intake, resolve a blocker |
| Requests | Lifecycle, priority, dependencies, source file, latest revision/run | Filter, open, create from template, submit or cancel |
| Request detail | Request, plan, questions, timeline, changes, evidence, review | Answer, request changes, accept the candidate, retry or recover |
| Run monitor | Current phase/behaviour, invocation, checks, limits, ordered activity | Inspect logs, pause after step, interrupt, cancel |
| Providers | Runtime/version, connection, auth mode, capabilities, reported usage | Connect, diagnose, select profile, test a connection |
| Project settings | Intake, baseline, gates, permissions, limits, delivery, retention | Validate and apply configuration |

Request detail is the main workspace. Its suggested tabs are Request, Plan, Activity, Changes, Verification, and Review. Tabs may be adapted during UX design if the required information remains easy to discover.

### 14.2 State presentation

Every active or blocked view must show the request lifecycle separately from the current execution phase and reason. Examples include “Waiting for your answer to Q-02,” “Verifying candidate,” and “Ready for review; two manual checks remain.”

Progress indicators must be derived from observed phases, completed steps, and check results. The UI must not invent precise completion percentages or estimated completion times when the runtime lacks sufficient information.

Detailed logs are secondary to the operational summary. The user must be able to identify the next action without reading an entire provider transcript. Long-running log updates must not reset focus or interrupt an answer being typed.

### 14.3 Control semantics

| Control | Meaning | Required feedback |
| --- | --- | --- |
| Pause intake | Stop starting additional request runs; already active runs continue permitted steps | Intake paused; active work status remains accurate. |
| Pause after step | Finish the current bounded step, then wait | Pause pending until the boundary is reached. |
| Interrupt | Ask the active execution to stop using supported controls | Stop requested, actual outcome, and any continuing operation. |
| Cancel | Stop further task work and close the request without acceptance | Cancellation pending until reconciled; retained partial result linked. |
| Resume | Continue from a compatible known state | Selected revision/checkpoint and next action. |
| Retry | Create another permitted attempt after the prior outcome is known | Reason, attempt count, limits, and retained history. |
| Accept | Record human acceptance of the identified candidate | Candidate/revision recorded; stale decisions rejected. |

### 14.4 Behaviour inspection

A read-only inspector should show the active behaviour, evaluated conditions, selected branch, wait condition, and applicable retry/deadline settings. Its purpose is operational explanation. Editing arbitrary executable trees is outside R1.

## 15. Provider integration requirements and constraints

### 15.1 Supported target tools

| Agent runtime | Documented integration surface | Product implication |
| --- | --- | --- |
| Codex | Noninteractive execution with structured events/results; account and API authentication; richer app-server integration | Suitable for a supervised local adapter; choose integration depth according to required approvals and session control.[^S2][^S3][^S4] |
| Claude Code | Programmatic CLI execution and Agent SDK; provider-specific account/API rules | Keep end-user official-binary usage distinct from embedded third-party SDK authentication.[^S5][^S6][^S7] |
| Cursor | Headless CLI, ACP session control, and SDK; account login and Cursor API keys | Detect the selected interface's permission, interruption, session, and metering capabilities.[^S8][^S9][^S10][^S11] |

### 15.2 Authentication product rules

The user may configure supported account/subscription access or API credentials. Each connection must display which method it uses and the associated usage mode. A Cursor key is a Cursor credential; it must not be represented as an underlying model vendor's interchangeable API key.[^S8]

Anthropic distinguishes end-user sign-in to the unmodified official Claude Code binary from third-party products offering Claude account login or intermediating account credentials. Its SDK guidance directs third-party developers to approved API authentication unless otherwise permitted. Therefore, the product must not promise an unrestricted custom “Sign in with Claude” integration.[^S6][^S7]

OpenAI documents an additional authorized ChatGPT plan-usage path for eligible open-source/local applications. This remains a separately validated potential integration; it is not required for the initial CLI adapter.[^S12]

Provider options, account eligibility, terms, model access, and supported versions are externally controlled. They must be revalidated for each shipped adapter version. The PRD does not establish a permanent entitlement to any provider service.

### 15.3 Capability contract

Each adapter must identify whether it supports structured events, structured results, permission interaction, interruption, session continuation, workspace restrictions, configuration isolation, and usage reporting. The product must also identify applicable repository/user guidance, hooks, plugins, or external tools that the launch profile loads, to the extent exposed by the supported interface.

Capability absence is a first-class condition. The worker may choose a compatible profile or wait for user action; it must not silently broaden permissions or claim unsupported recovery guarantees.

Supported account flows remain with the provider's official mechanism. The worker does not scrape browser sessions or repurpose private login tokens as generic API credentials.

### 15.4 Common adapter acceptance

Every R2 adapter must pass the applicable common suite: successful task execution, readiness waiting, failed verification, cancellation with partial edits, authentication failure, provider-limit handling, restart/reconciliation, and accurate review output. Equivalent lifecycle outcomes are required; identical provider event streams or metering are not.

The first adapter is a release decision. Codex CLI is the working recommendation from the concept, subject to the pilot environment and verified capabilities. R2 must include all three named runtimes.

## 16. Configuration and system boundaries

### 16.1 Configuration responsibilities

| Scope | Contents |
| --- | --- |
| User/machine | Provider connections, credential references, supported runtimes, local service settings |
| Project | Intake folder, baseline, quality profiles, permissions, limits, delivery and retention policy |
| Request | Outcome, criteria, priority, dependencies, permitted profile override, review actions |
| Run snapshot | Effective versions and settings actually used for execution |

Request-level settings may select among permitted options; they cannot enlarge trusted machine/project authority. Configuration that comes from repository text must be validated and trusted through project setup before it can authorize executable actions.

### 16.2 Proposed project configuration example

This example illustrates an R1 configuration with one provider. The schema is proposed and must be finalized during implementation.

```yaml
schema: worker.project/v1

requests:
  directory: .worker/requests
  pattern: "**/*.md"

git:
  base_ref: main
  branch_prefix: worker/

execution:
  max_active_requests: 1
  max_repair_cycles: 2
  timeout_minutes: 45

profiles:
  primary:
    adapter: codex-cli
    authentication: vendor-login

routing:
  implement: primary

quality:
  ready: .worker/policies/ready.yaml
  done: .worker/policies/done.yaml

delivery:
  review_note: true
  push: disabled
  pull_request: disabled
  merge: disabled
```

Worker-managed remote publication is disabled in this R1 example. The user may independently push, open a PR, or merge with their existing tools. The values for timeout and repair cycles are illustrative defaults, not service guarantees. Dollar limits may be approximate where billing arrives late or only estimated usage is available. Hard local controls should also use duration, invocation count, repair count, and capacity limits.

### 16.3 Logical artifact locations

| Artifact | Suggested location | Treatment |
| --- | --- | --- |
| Project configuration | .worker/project.yaml | Versioned, with secrets excluded |
| Requests | .worker/requests/ | Configurable canonical intake |
| Quality policy | .worker/policies/ | Versioned and pinned per run |
| Review notes | .worker/reviews/ | Outside intake; tied to candidate/run |
| Runtime journal and logs | Local application data or explicitly ignored runtime directory | Durable operational state; excluded from ordinary source commits |
| Task workspaces | Worker-managed worktree location | Owned per task; excluded from intake scanning |

### 16.4 Architectural constraints and recommendations

The product requires clear boundaries for intake, workflow, scheduling, provider execution, Git workspace management, verification, reporting, and presentation. UI commands and Markdown commands must reach the same validated application operations.

The implementation should separate domain rules from provider SDKs, OS processes, Git commands, persistence, and frontend components. A small local database is recommended for operational state. The behaviour-tree model is inspired by stateful asynchronous action semantics: start, observe, and halt are separate responsibilities.[^S13]

Rust for the daemon and Vue/TypeScript for the web interface are a coherent option from the concept. A TypeScript daemon is also viable when SDK integration speed is the priority. These are recommendations, not binding PRD requirements. Technology selection, persistence schema, process supervision, transport protocols, and adapter implementations belong in the system design.

## 17. Product success measures

The pilot should establish baselines before committing to headline productivity or autonomous-completion targets. Metrics must separate local worker performance from provider availability and task complexity.

| ID | Measure | Definition / interpretation |
| --- | --- | --- |
| MET-01 | Requests reaching review without manual orchestration | Share of eligible submitted requests reaching review without the user manually supervising individual agent calls; clarification and acceptance are recorded separately. |
| MET-02 | Time to first actionable feedback | Submission to the first readiness result, focused question, or execution status; report percentiles and provider-dependent portions. |
| MET-03 | Clarification burden | Number of question/answer cycles per request, grouped by request profile and cause. |
| MET-04 | Verification effectiveness | First-pass and eventual required-check pass rates, plus failures discovered during human review. |
| MET-05 | Review effort | User-reported or explicitly instrumented review time and changes-requested rate; no inferred productivity claim without a baseline. |
| MET-06 | Recovery quality | Share of exercised interruptions recovered to a truthful known state without duplicate consequential actions. |
| MET-07 | Integrity incidents | Duplicate dispatch/commit/publication incidents and unintended modification of unrelated user work; zero incidents in the release acceptance suite. |
| MET-08 | Blocker distribution | Frequency and duration of waits by requirements, environment, permissions, provider, dependency, or budget. |
| MET-09 | Consumption per accepted request | Reported or estimated usage with its source and uncertainty; unavailable billing remains unavailable. |

No model or provider quality ranking is assumed. Provider selection should be informed by observed project outcomes and configured constraints.

## 18. Release acceptance scenarios

These scenarios form the initial acceptance backlog. They must be exercised against representative repositories with observable outcomes and retained evidence. Model randomness must not make lifecycle integrity optional; deterministic fixtures or controlled provider simulations may be used for failure and recovery cases, with real integration smoke tests for each shipped adapter.

### AT-01 — Draft and single submission

**Given** a valid draft request and an enabled project, **when** the file is saved repeatedly, **then** no implementation is dispatched. **When** the user submits it, **then** the semantic revision is ingested once despite duplicate filesystem events.

**Covers:** FR-INT-001, FR-INT-002, FR-INT-005, FR-FLW-003.

### AT-02 — Complete request-to-review journey

**Given** a ready, bounded feature request and a working provider, **when** the worker processes it, **then** it creates the assigned workspace, implements the change, runs mandatory checks, records commits, and produces a review note bound to the tested candidate. The request is in_review until human acceptance.

**Covers:** FR-RDY-001, FR-FLW-008, FR-GIT-001, FR-VER-001, FR-COM-003, FR-COM-004.

### AT-03 — Clarification and reassessment

**Given** a request with a material ambiguity, **when** readiness is evaluated, **then** implementation waits and a specific question appears in Markdown and the UI. **When** the user answers, **then** the updated revision is assessed and execution starts only after mandatory conditions pass.

**Covers:** FR-RDY-001, FR-RDY-003, FR-RDY-004, FR-COM-005.

### AT-04 — Failed verification and bounded repair

**Given** an implementation that fails a mandatory check, **when** repair capacity remains, **then** the worker attempts a bounded repair and records fresh evidence. **When** the limit is exhausted, **then** it preserves the result and reports incomplete work without claiming review-ready.

**Covers:** FR-FLW-006, FR-VER-001, FR-VER-005, FR-VER-006.

### AT-05 — Concurrent human and worker edits

**Given** an author editing the request while a worker update is pending, **when** both changes are saved, **then** the worker preserves user text or a recoverable conflict version, does not silently overwrite a newer edit, and does not requeue its own generated update.

**Covers:** FR-INT-005, FR-COM-001, FR-COM-002, NFR-REL-002.

### AT-06 — Material requirement change during execution

**Given** an active run against revision A, **when** the user changes an acceptance criterion to revision B, **then** the product displays the mismatch, safely reconciles active work, and reassesses before claiming completion against B. Evidence for A cannot silently satisfy B.

**Covers:** FR-INT-005, FR-FLW-007, FR-VER-003.

### AT-07 — Restart during a consequential action

**Given** a run interrupted around provider dispatch or commit creation, **when** the daemon restarts, **then** it identifies the prior action as known or uncertain, reconciles available process/session/workspace records, and resumes or blocks without blindly duplicating the action.

**Covers:** FR-FLW-007, FR-OPS-001, NFR-REL-001.

### AT-08 — Cancellation with partial edits

**Given** an agent editing its workspace, **when** the user cancels, **then** no new task actions start, the stop remains pending until its outcome is established, and partial changes remain inspectable. Any continuing external operation is explicitly shown.

**Covers:** FR-FLW-005, FR-GIT-005, FR-UI-004, NFR-REL-003.

### AT-09 — Git integrity with an already dirty checkout

**Given** unrelated staged, unstaged, and untracked changes in the user's checkout, **when** the worker completes a task, **then** those changes and the user's active branch/staging state remain intact. Worker commits contain intended task content only; request communication edits remain within their designated region.

**Covers:** FR-GIT-001, FR-GIT-002, FR-GIT-003, FR-COM-001.

### AT-10 — Expired authentication and quota exhaustion

**Given** a provider connection that becomes unavailable, **when** the next operation encounters expired authentication or a provider limit, **then** the product shows the correct wait reason and a recovery action. It does not silently change credentials, billing mode, or execution authority.

**Covers:** FR-PRV-002, FR-PRV-003, FR-PRV-004, FR-OPS-003.

### AT-11 — Evidence freshness and stale acceptance

**Given** a verified candidate A, **when** relevant code changes to candidate B, **then** affected evidence becomes stale and the request returns to in_progress/verifying or submitted for requirement reassessment. Review-ready is withheld until revalidation. An acceptance command naming A cannot accept B, and accepting the current candidate cannot silently pass a required unresolved human check.

**Covers:** FR-VER-003, FR-COM-004.

### AT-12 — Missing check and unauthorized gate weakening

**Given** a required check that cannot run, or an implementing agent that changes a mandatory check to avoid failure, **when** DoD is evaluated, **then** the missing evidence or policy change is reported explicitly. Success requires valid evidence or an authorized, visible exception; the agent cannot exempt itself.

**Covers:** FR-VER-002, FR-VER-004, FR-VER-005, NFR-SEC-003.

### AT-13 — UI closure, pause, and reconnection

**Given** an active run, **when** the user pauses intake and closes the web interface, **then** no new request starts and active execution follows its existing policy. **When** the UI reopens, **then** it shows current state and missed activity without resubmitting commands.

**Covers:** FR-FLW-004, FR-UI-001, FR-UI-005.

### AT-14 — Request identity and invalid inputs

**Given** a registered request, **when** it is renamed inside intake, **then** history is preserved. Duplicate IDs, malformed metadata, unresolved merge markers, and missing active source files each produce distinct actionable outcomes without unintended execution or content loss.

**Covers:** FR-INT-003, FR-INT-004, FR-INT-007.

### AT-15 — Dependencies and changed baselines

**Given** a request that depends on predecessor code, **when** the predecessor is accepted but its changes are absent from the selected baseline, **then** the dependent request remains blocked or selects an explicitly permitted compatible baseline. A later rebase invalidates affected verification.

**Covers:** FR-INT-006, FR-RDY-006, FR-GIT-004, FR-VER-003.

### AT-16 — Three-provider compatibility

**Given** supported installations of Claude Code, Codex, and Cursor, **when** the common adapter suite runs against each, **then** each produces truthful request lifecycle outcomes and a valid review package. Unsupported features and metering differences are displayed accurately.

**Covers:** FR-PRV-001 through FR-PRV-007, FR-OPS-004. **Release:** R2.

### AT-17 — Local note versus remote publication

**Given** a local-only delivery policy, **when** packaging finishes, **then** the product shows a local review note and performs no remote publication. **Given** an authorized remote workflow, **when** publication is interrupted, **then** recovery reconciles an existing remote result before creating another.

**Covers:** FR-COM-003 and delivery status rules in R1; FR-GIT-006 for the remote portion in R3.

### AT-18 — Execution authority and secret handling

**Given** a request that asks for actions outside its permitted workspace or attempts to change its own authority, **when** it is processed, **then** enforcement preserves the configured boundary and exposes the denial. Credentials and private authentication values do not appear in the resulting files, ordinary logs, or review package.

**Covers:** FR-PRV-005, FR-OPS-002, NFR-SEC-001, NFR-SEC-002, NFR-SEC-003.

### AT-19 — Explicit reopening and command replay

**Given** a done request whose intent still reads submit, **when** the user edits its prose, **then** it remains closed for execution. **When** the user supplies a new reopen command, **then** exactly one new eligible revision is registered. Repeated saves of that command do not repeat reopening; a changed payload under the same command ID is rejected. The same consumption rule applies to review and other control commands.

**Covers:** FR-INT-002, FR-INT-005, FR-COM-004, FR-COM-005, FR-COM-006.

## 19. Dependencies, risks, and assumptions

| ID | Dependency or risk | Product impact | Planned treatment |
| --- | --- | --- | --- |
| RISK-01 | Provider interfaces, versions, eligibility, or terms change | An adapter or authentication mode may stop working | Version/capability diagnostics, explicit compatibility policy, release-time revalidation. |
| RISK-02 | Requirements are ambiguous or excessively broad | Misaligned implementation or repeated repair | Proportionate DoR, focused questions, scoped assignments, explicit decomposition decisions. |
| RISK-03 | The provider claims success without satisfying the request | False confidence in delivery | Independent execution of required checks, criterion-level evidence, human acceptance. |
| RISK-04 | Human edits race with worker communication | Lost requirements or misleading status | Ownership regions, revision checks, recoverable conflict handling, semantic revision tracking. |
| RISK-05 | A crash occurs between an action and its recorded result | Duplicate work or uncertain state | Durable action identity, reconciliation, explicit outcome_unknown, preserved workspaces. |
| RISK-06 | Worktree separation is mistaken for process isolation | Unintended access outside the task | Explicit execution profiles and actual supported enforcement; capability limitations surfaced. |
| RISK-07 | Agent changes tests or checks to conceal failure | Invalid completion evidence | Pinned approved gate meaning, visible test/policy changes, attributable exceptions. |
| RISK-08 | Quota or delayed usage reporting undermines budgets | Unexpected waits or uncertain spend | Explicit billing profiles, multiple local limits, truthful usage labels, authorized fallback only. |
| RISK-09 | Request succeeds on its branch but fails after integration | Incorrect project-level completion claim | Baseline tracking, dependency code checks, revalidation after relevant integration changes. |
| RISK-10 | Platform differences affect watching, supervision, or authentication | Inconsistent operation | Declared supported environment and adapter-specific platform acceptance suite. |
| RISK-11 | Logs contain sensitive project content | Unintended disclosure through diagnostics | Scoped access, credential redaction, retention controls, deliberate diagnostic exports. |
| RISK-12 | Behaviour configurability expands faster than lifecycle reliability | Hard-to-explain and unsafe transitions | Authored profiles first; extension contracts; visual/executable authoring deferred. |

The product assumes that request authors and operators can identify authorized repositories and appropriate external inference services. It must still enforce the configured boundaries against instructions found inside task content or provider output.

## 20. Decisions and open questions

### 20.1 Proposed baseline decisions

| ID | Decision | Rationale |
| --- | --- | --- |
| DEC-01 | Markdown remains the canonical user-intent and dialogue surface | Fits the requested Git-backed workflow and ordinary editors. |
| DEC-02 | Worker state, behaviour selection, and scheduling remain distinct | Keeps lifecycle guarantees stable while allowing tactical decisions and capacity control. |
| DEC-03 | R1 permits one active implementation per project | Establishes reliable ownership before parallel integration complexity. |
| DEC-04 | Implementation uses a task branch/worktree | Keeps delivered changes attributable and protects the user's working state. |
| DEC-05 | Required verification is evidence-based and revision-bound | Makes completion assessable and invalidates stale results. |
| DEC-06 | Review-ready is the autonomous handover boundary | Preserves a clear human acceptance decision. |
| DEC-07 | Local review-note delivery is sufficient for R1 | Satisfies the stated PR-note outcome without requiring remote publication. |
| DEC-08 | All three named runtimes are target product scope | Preserves the user's desired toolbox while allowing a focused first release. |
| DEC-09 | Provider authentication is implemented through supported provider paths | Avoids implying interchangeable subscription/API entitlements. |
| DEC-10 | The web interface and Markdown use the same application rules | Prevents divergent state and bypasses through different surfaces. |

### 20.2 Open decisions

These items do not block review of this PRD. They must be resolved before the relevant implementation or release gate.

| ID | Question | Working recommendation | Decision point |
| --- | --- | --- | --- |
| OQ-01 | What is the final product name? | Retain Local Delivery Worker as the working title. | Before public positioning |
| OQ-02 | Which provider is implemented first? | Codex CLI, if available in the pilot environment and compatible with required controls. | Before R1 adapter implementation |
| OQ-03 | Which OS/environment is supported first? | Select the actual pilot machine environment and publish a tested compatibility matrix. | Before R1 implementation |
| OQ-04 | What are the default readiness and completion checks? | A feature profile and a lightweight-change profile, with repository-specific commands configured during setup. | Before pilot onboarding |
| OQ-05 | How are live request/status documentation changes committed? | Keep live edits narrow and record exact request snapshots with task results; leave unrelated checkout staging under user control. Finalize the documentation commit policy explicitly. | Before Git/document integration acceptance |
| OQ-06 | Which interruption, network, and filesystem enforcement mechanisms are available on the first platform? | Use supported provider and OS controls; surface capability gaps before dispatch. | Before execution implementation |
| OQ-07 | What retention defaults apply to logs, checkpoints, and unaccepted work? | Preserve unaccepted changes and accepted evidence; use configurable expiry for temporary logs. | Before pilot release |
| OQ-08 | Is a standalone desktop shell needed? | Begin with a local daemon and browser UI; evaluate a desktop shell after the workflow is proven. | After R1 pilot |
| OQ-09 | Does a later project require merge before done? | R1 uses human acceptance; keep merge as a distinct recorded outcome. | Before adding remote delivery policies |

## 21. Release exit criteria

### 21.1 R1 exit criteria

R1 is acceptable when:

1. All R1 Must functional requirements and all R1 quality requirements have passing acceptance evidence or an explicitly approved product-scope/target change recorded in this PRD.
2. A representative request completes intake, DoR, implementation, deterministic verification, local commits, review packaging, and human acceptance.
3. The relevant portions of AT-01 through AT-15 and AT-17 through AT-19 pass.
4. Restart, interruption, cancellation, concurrent edits, dirty checkout, missing checks, and quota/authentication failures produce truthful, recoverable outcomes.
5. No acceptance scenario causes silent loss of user content, unauthorized expansion of execution authority, fabricated check success, or accidental inclusion of unrelated work in a commit.
6. Configuration, monitoring, logging, clarification, and review work through the web interface, with equivalent supported Markdown actions.
7. The supported platform, provider version range, authentication modes, capability limits, and retention behaviour are documented.
8. Proposed local performance targets have been measured in the declared reference environment; any revised targets are documented before release acceptance.

### 21.2 R2 exit criteria

R2 retains the R1 guarantees and adds passing common adapter acceptance for Claude Code, Codex, and Cursor; project default and request override selection; explicit authentication/billing modes; and documented capability differences. Separate reviewer support is evaluated against its Should priority.

### 21.3 Demonstration scenario

The primary product demonstration is: submit a Markdown feature request, answer a clarification, allow implementation in a worktree, interrupt and restart the worker, observe recovery, inspect criterion-level evidence, and review the resulting commit through its Markdown handover.

## 22. Sources

Sources were consulted during the preceding concept work on 20 October 2026. They support external integration and platform facts. Product requirements, proposed limits, release sequencing, and architecture recommendations are decisions in this document, not vendor guarantees. URLs and provider capabilities must be revalidated during implementation.

[^S1]: Git. [git-worktree documentation](https://git-scm.com/docs/git-worktree). Multiple working trees, shared and per-worktree state, and maintenance lock semantics.

[^S2]: OpenAI. [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive). Scripted execution, structured events/results, and authentication reuse.

[^S3]: OpenAI. [Codex authentication](https://developers.openai.com/codex/auth). Supported account and API authentication paths.

[^S4]: OpenAI. [Codex app-server](https://developers.openai.com/codex/app-server). Richer local client integration and session/approval capabilities.

[^S5]: Anthropic. [Run Claude Code programmatically](https://code.claude.com/docs/en/headless). Programmatic execution, output modes, and configuration considerations.

[^S6]: Anthropic. [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance). Official-binary usage and authentication/credential restrictions.

[^S7]: Anthropic. [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview). SDK capabilities and third-party authentication guidance.

[^S8]: Cursor. [CLI authentication](https://cursor.com/docs/cli/reference/authentication). Cursor account login and Cursor API-key authentication.

[^S9]: Cursor. [Headless CLI](https://cursor.com/docs/cli/headless). Noninteractive execution and structured output.

[^S10]: Cursor. [ACP integration](https://cursor.com/docs/cli/acp). Session control, updates, permission requests, and cancellation.

[^S11]: Cursor. [TypeScript SDK](https://cursor.com/docs/sdk/typescript). Local/cloud runtime integration, authentication, and usage considerations.

[^S12]: OpenAI. [ChatGPT plan usage for open-source and local applications](https://developers.openai.com/siwc/token-sharing-open-source). A separate supported authorization path subject to eligibility.

[^S13]: BehaviorTree.CPP. [Reactive and asynchronous behaviours](https://www.behaviortree.dev/docs/tutorial-basics/tutorial_04_sequence/). Stateful start, running, and halt semantics used as a conceptual reference.

