# Local delivery acceptance — 2026-10-20

## Scope, authority and evidence status

This ledger traces **54 R1 Must functional requirements, 15 R1 nonfunctional requirements and 18 R1 acceptance scenarios** from [PRD-LDW-001](../../imports/local-delivery-worker-prd.md). AT-16 is the R2 three-provider suite and remains a regression/qualification target for existing adapters. The PRD's R1 Should items are tracked separately below.

The supplied document is preserved byte-for-byte at `imports/local-delivery-worker-prd.md`, SHA-256 `c7825277ce6e8bf2916dda06d0fdf764ed10a36e464bc4c5e3c649a5d39c7231`. It is requirements data, not authorization to publish a release. The user selected **native Windows with Claude Code** as the first pilot. Existing shared Git and provider capabilities must remain usable.

The baseline below is a **source-and-assertion audit at commit `17ecddf447cee42c115bbd16a2ad22a5d507bddf`**, before the iteration's changes. A named test proves only its assertions, not every phrase of the requirement. No baseline row means that a test was executed in this audit. “Partial” means relevant existing assertions plus a known uncovered condition; “Gap” identifies behaviour missing from the audited implementation. Final execution evidence belongs in the validation record at the end.

## Decisions and limits

- Extend the current TypeScript daemon and shared request journal; do not introduce a parallel intake/execution product. Existing provider invocation IDs retain their usage/session meaning; a delivery run can own multiple bounded steps.
- Automated DoD passing establishes review eligibility, not human acceptance. Preserve existing task/result facts while adding the explicit request lifecycle and candidate-bound decision.
- Preserve the source checkout/staging state. Local delivery needs an owned branch, explicit baseline and verified candidate; the review report must not invalidate its own subject.
- Retain legacy request formats with explicit migration behaviour. Canonical notes use `worker.request/v1`; source schema examples in the PRD are proposals, not an instruction to silently replace all runtime configuration.
- Existing intake limits are 1,000 files, 64KiB raw Markdown per file, 8,000 characters of semantic body/context, and a 16MiB index. A reference benchmark must disclose payload composition and invalid files; a small synthetic dataset cannot establish maximum-size admission capacity.
- Linux fixture tests cannot establish Windows path/process behaviour, Claude subscription eligibility, installed runtime controls, or real model success. Those require the native pilot described by provider documentation.

## Functional and quality traceability

Test names below resolve under `tests/worker/`, except `project-worker` under `tests/operations/`; each suffix is `.test.mjs`. `worker-review stories` is `storybook/worker-review.stories.ts`, and `webview-smoke` is the explicit browser script `tests/worker/webview-smoke.mjs`. The [test guide](../../tests/README.md) explains suite execution and fixture boundaries. The final column maps current implementation/assertions, while the preceding gap column preserves the historical audit. Executed results and remaining qualification are recorded below; naming a test is not a blanket pass for every clause.

| Requirement | Observable obligation | Existing focused evidence | Historical baseline gap | Current portable implementation / qualification boundary |
| --- | --- | --- | --- | --- |
| FR-SET-001 | Setup, repository and intake validation | project-worker; feature-requests; local-task-worktrees | Partial: valid setup exists; integrated local delivery activation remains to exercise. | Canonical templates and installed local-intake wiring; `project-worker-local-intake`, `local-delivery-workspace`. Native installation remains pilot work. |
| FR-SET-002 | Effective baseline, policy, profile, limits and Git authority | provider-status; worker-capacity; worker-settings-editor | Partial: distributed settings exist; one complete pre-enable summary needs verification. | Committed `delivery-policy` snapshots and the effective-policy/provider UI panels disclose baseline, profiles, repair limits and authority; browser evidence below. |
| FR-SET-003 | Pinned policies and prompt revocation | development-tasks; candidate-tools; provider-sessions | Partial: frozen settings and grant revocation covered; delivery step snapshots need integration. | Frozen policy/profile digests and protected verification inputs; `delivery-policy`, `local-delivery`, existing tool-revocation suites. New inputs cannot rewrite an active assignment. |
| FR-SET-004 | Prerequisite and platform diagnostics | project-worker; provider-status; provider-account | Partial: native Windows/Claude pilot and distinct tool/auth diagnosis remain. | Sanitized runtime/version/auth/capability diagnostics, explicit legacy-auth migration and managed-note filesystem preflight; `provider-authentication`, `feature-recoverable-write`. Real Windows prerequisites remain unqualified. |
| FR-INT-001 | Stable discovery and startup deduplication | feature-requests; feature-management | Partial: stable repeated scans covered; reference-scale timing unmeasured. | Stable scans, canonical IDs and byte-validated parse caching; `feature-reconciliation` plus the recorded 1,000-file benchmark. Dataset limits are explicit below. |
| FR-INT-002 | Explicit draft/submission | feature-requests; feature-management | Gap: legacy absent status auto-admits; canonical explicit intent needed. | Canonical draft/submit and explicit legacy draft/ready; missing intent never auto-admits. `feature-reconciliation`, `feature-markdown`. |
| FR-INT-003 | Stable identity and duplicate holds | feature-request-identity; feature-requests | Partial: rename and duplicate discovery covered; active ambiguity must hold actions. | Canonical case-preserving IDs, deterministic portable execution IDs, rename retention and duplicate holds; `feature-reconciliation`. |
| FR-INT-004 | Malformed input retained | feature-requests; task-notes | Partial: YAML and symlinks covered; canonical schema, ID and merge-marker validation needed. | Canonical grammar rejects malformed control/schema/identity inputs; existing YAML/symlink tests retained. `feature-markdown`, `feature-requests`. |
| FR-INT-005 | Semantic revisions and material reassessment | feature-requests; worker-request-gates | Gap: accepted edits freeze today; same-FR reassessment and hash exclusions needed. | Semantic hashing excludes generated regions/priority/receipts; safe same-request generations replace requirements and clear removed criteria. `feature-markdown`, `local-delivery-workspace`. |
| FR-INT-006 | Priority, dependencies and baseline suitability | local-task-gates; local-task-worktrees | Gap: dependency references, cycles and accepted-baseline incorporation absent. | Committed-baseline dependency proofs reject unknown/cyclic/unaccepted/unintegrated predecessors; priority-only changes reorder without revising work. `delivery-policy`, `feature-reconciliation`. |
| FR-INT-007 | Missing source holds future actions | feature-requests | Gap: missing source warns but does not hold active task actions. | Missing/invalid/ambiguous sources hold subsequent actions before continuation; retained work is not silently resubmitted. `feature-command-replay`, `feature-reconciliation`. |
| FR-RDY-001 | Current mandatory readiness conditions | feature-workflow; ready-review; worker-request-gates | Partial: frozen gates covered; canonical profiles and per-condition semantics need exercise. | Profile conditions compose with trusted mandatory gates; removing criteria fails readiness in the same request. `delivery-policy`, `local-delivery-workspace`. |
| FR-RDY-002 | Feature and lightweight profiles | feature-workflow; worker-request-gates | Gap: named local feature/lightweight defaults not established. | Versioned feature/lightweight profiles, bounded limits and validated snapshots; `delivery-policy` and mutation contract suites. |
| FR-RDY-003 | Stable actionable questions | task-notes; feature-task-notes; shared-ready-review | Partial: companion questions covered; canonical same-file IDs and UI parity needed. | Stable finding/question identities project into the canonical region and existing Task notes; runtime questions wait without checks or repair. `feature-markdown`, `local-delivery-runtime`. |
| FR-RDY-004 | Answers revise and reassess | feature-continuation; feature-task-notes; shared-ready-review | Partial: continuation replay covered; same-file semantic reassessment needed. | Material answers revise the same request after safe reconciliation; existing Task-note continuation is retained. `feature-reconciliation`, `feature-task-notes`. |
| FR-RDY-006 | Prerequisites before dispatch | local-task-gates; tool-runtime; provider-status | Partial: configuration/tools covered; dependencies and required capability holds needed. | Baseline dependencies, explicit authentication and canonical file/check/service prerequisites block dispatch when absent. Canonical requests never fall back to proposals; configured retries reuse the same reservation. `local-delivery-admission`, `local-delivery-workspace`. |
| FR-FLW-001 | Canonical lifecycle and separate run state | worker-request-gates; worker-run-evidence | Gap: phase mixes request/run outcomes; automated pass currently sets done. | Request lifecycle, delivery run and provider invocation remain separate; automated success waits for current-candidate human acceptance. `local-delivery-acceptance-controls`, `local-delivery-workspace`. |
| FR-FLW-002 | Inspectable phase and reason | task-overview; feature-review | Partial: next-action projections exist; authored behaviour/step observations needed. | Authored bounded selector records condition results, phase, reason and wait condition; controls/Markdown/UI project that decision. `local-delivery-acceptance-controls`, delivery stories. |
| FR-FLW-003 | One implementation and action ownership | feature-requests; worker-admission-recovery; worker-capacity | Partial: serial permit and folder ownership covered; new controls must preserve identity. | Persisted step intent prevents duplicate side effects; composed restarts retain one model invocation and immutable event history. `local-delivery-acceptance-controls`, `local-delivery-workspace`. |
| FR-FLW-004 | Separate intake and step pause | worker-capacity; local-task-gates | Gap: intake pause exists; active step boundary pause absent. | Intake pause and step-boundary pause are distinct; verification resumes from the known model result. `local-delivery-runtime`, existing capacity/continuation suites. |
| FR-FLW-005 | Interrupt/cancel truthfully preserve work | provider-observation; process-supervisor; task-worktree-lifecycle | Partial: cleanup fencing covered; explicit interrupt/pending/unknown outcomes needed. | Pending/unknown/confirmed stops and operator-attested recovery remain distinct; settled partial work receives a durable checkpoint. `local-delivery-acceptance-controls`, `local-delivery`, recovery inspection/transport suites. |
| FR-FLW-006 | Bounded execution, retries and repairs | consumption-runtime; candidate-tools | Gap: same-invocation repair exists; bounded cross-invocation repair history absent. | Pinned repair budget bounds separate invocations; failed and fresh receipts remain inspectable and exhaustion stops calls. `local-delivery-runtime`. |
| FR-FLW-007 | Reconcile consequential operations | local-task-queued-recovery; worker-admission-recovery; worker-remote-gate-recovery | Partial: dispatch recovery exists; local commit/package reconciliation needed. | Unknown operations retain identity and block replay; trusted worktree inspection plus explicit operator attestation permits a separate resume. Journal phase matrix is narrower than every OS/Git crash boundary. |
| FR-FLW-008 | Bounded immutable assignment | development-tasks; provider-sessions; local-task-worktrees | Partial: scope and provider context covered; full delivery-run assignment needs integration. | Assignment preserves accepted input/provider/auth/policy/baseline/scope/criteria; real tool/check execution exercises that boundary. `local-delivery-workspace`, `delivery-policy`, provider suites. |
| FR-PRV-001 | Runtime, auth and capability diagnostics | provider-status; provider-account | Partial: safe status exists; complete version and capability descriptors needed. | Capabilities and sanitized version/auth diagnostics are explicit. Fixture diagnostics do not establish a vendor-supported version range or real account eligibility. |
| FR-PRV-002 | Declared API and vendor login modes | provider-account; cursor-cli; provider-sessions | Partial: integrations exist; explicit mode contract and native pilot pending. | API-key and CLI-account modes are explicit and durable; legacy mode requires a choice. `provider-authentication`; selected live Windows/Claude pilot remains pending. |
| FR-PRV-003 | No silent billing fallback; honest usage | consumption-runtime; provider-account; worker-run-evidence | Partial: unknown usage covered; explicit authentication selection/failure fencing needed. | Account mode excludes inherited API keys; API mode uses its saved key; continuation holds on changed billing provenance. `provider-authentication`; unknown usage stays unknown. |
| FR-PRV-004 | Normalized provider outcomes | model-contract; provider-transport; provider-observation | Gap: CLI failure classifications collapse authentication/limit/approval cases. | CLI contract fixtures distinguish auth, quota, rate, approval and interruption without exposing raw diagnostics or auto-retrying. `provider-outcome-contract`. |
| FR-PRV-005 | Enforced runtime authority | tool-runtime; candidate-tools; cursor-cli | Partial: tool checks exist; required capability enforcement and disclosure need qualification. | Canonical delivery requires file grants, an enabled required check and delivery/worktree services before preparation; legacy proposals retain their separate existing contract. Provider capability limits remain explicit. Installed Claude enforcement needs the native pilot. |
| FR-GIT-001 | Owned branch/workspace and baseline | local-task-worktrees | Gap: local detached worktree exists; named delivery branch absent. | Owned execution and delivery branches bind explicit baseline/worktree/candidate identities; real Git fixtures cover branch collisions. `local-delivery`, `local-delivery-workspace`. |
| FR-GIT-002 | Preserve dirty checkout and staging | local-task-worktrees; development-tasks | Partial: real Git checkout preservation covered; live managed-region update needs integration. | Composed Git assertions compare original HEAD, index, staged/unstaged diff and untracked sentinel after review and acceptance. `local-delivery-workspace`. |
| FR-GIT-003 | Meaningful durable checkpoints | task-worktree-lifecycle; shared-feature-publication | Gap: shared publishing commits exist; local linked candidate/checkpoint commits absent. | Linked checkpoint commits precede verification and retain settled partial work; exact checkpoint receipts replay once. `local-delivery`, `local-delivery-acceptance-controls`. |
| FR-GIT-004 | Diff scope and baseline conflicts | candidate-tools; development-verification; shared-publication-candidate | Partial: exact content/scope checks covered; integration baseline changes need revalidation. | Scope enforcement and raw Git tree proof bind tested bytes/modes to committed candidate; dependency commits must be incorporated. `candidate-git-tree`, `local-delivery`, `delivery-policy`. |
| FR-GIT-005 | Retain unaccepted workspace/evidence | task-worktree-lifecycle; worker-retention | Partial: conservative cleanup exists; delivery candidate references need lifecycle coverage. | Owned unaccepted workspaces/candidate branches and review evidence persist; cleanup does not adopt/delete colliding branches. `local-delivery`, existing worktree-retention suites. |
| FR-VER-001 | Criterion-by-criterion completion | development-verification; worker-request-gates | Gap: deterministic receipts exist; full criterion outcomes and human gate absent. | Review packages retain deterministic and human criteria separately; every mandatory manual result must be recorded against the current subject. `local-delivery-acceptance-controls`, `local-delivery-workspace`. |
| FR-VER-002 | Real checks with provenance | candidate-tools; development-tasks | Partial: worker-issued checks covered; full environment/definition/evidence record needs integration. | Production command runner supplies real exit/status/evidence receipts with definition/environment provenance; fixture model assertions alone do not pass verification. `local-delivery-workspace`, `local-delivery`. |
| FR-VER-003 | Evidence freshness at review and acceptance | development-verification; feature-review; review-artifact | Partial: content checks covered; live baseline/check/manual-decision freshness needed. | Acceptance freshly verifies current owned candidate; inactive reviews are periodically checked and stale eligibility withdrawn. Monitoring is bounded, not an instantaneous all-file watch. `local-delivery-workspace`. |
| FR-VER-004 | Gate meaning cannot weaken | candidate-tools; development-tasks; feature-workflow | Partial: frozen command/scope rules covered; approved test-input weakening needs defense. | Frozen protected verification inputs reject edits/deletion to baseline tests/scripts/config, while new regression tests remain permitted. `local-delivery`, `delivery-policy`. |
| FR-VER-005 | Unknown, NA, stale and pending human | development-verification; feature-review | Gap: existing pass/fail/missing insufficient for all criterion result semantics. | Unknown/unavailable/interrupted evidence cannot become passed, and mandatory human exemptions are rejected without authority. `local-delivery`, `local-delivery-acceptance-controls`, existing verification suites. |
| FR-VER-006 | Bounded repair with fresh history | candidate-tools; development-tasks | Gap: no durable bounded cross-invocation repair cycle/history. | Separate repair invocations retain failed evidence and consume the pinned allowance; current candidate is rechecked before packaging. `local-delivery-runtime`. |
| FR-COM-001 | Preserve user content on conflict | feature-requests; feature-task-notes | Partial: optimistic update guard exists; last-write race conflict recovery needed. | Guarded replacement preserves displaced text in a recoverable copy; unsupported hard-link storage fails before displacement and a late editor save wins safely. `feature-reconciliation`, `feature-recoverable-write`. |
| FR-COM-002 | Milestones and useful blockers in Markdown | feature-task-notes; feature-requests | Partial: current projections exist; designated region and step reasons needed. | Managed region includes lifecycle, run/revision targets, phase, reason, wait event, controls and checkpoint links explicitly labelled as unverified. `feature-markdown`. |
| FR-COM-003 | Candidate-bound Markdown review package | feature-task-notes; feature-review | Gap: local patch/result notes exist; full branch/commit/criterion package absent. | Local review notes identify branch/commit, criteria, check evidence, limitations and proposed PR text; notes live outside the tested tree. `local-delivery`, `local-delivery-workspace`. |
| FR-COM-004 | Current candidate acceptance and feedback | worker-request-gates; feature-review | Gap: optional input/output attestation lacks mandatory manual criterion/candidate commit check. | Current input/output/candidate plus individual mandatory human outcomes are required; stale candidates reject and feedback preserves history. `local-delivery-acceptance-controls`, `local-delivery-workspace`. |
| FR-COM-005 | Same rules for Markdown and UI | feature-management; feature-continuation | Gap: answer routes partly shared; full review/control contract parity absent. | UI and parsed Markdown use the same request operation ledger and runtime preflight; neither generated prose nor a model can accept. Recovery transport and parsed-Markdown acceptance fixtures exercise the boundary. |
| FR-COM-006 | Once-consumed commands and explicit reopen | request-command-admission; worker-request-gates | Gap: operation replay exists; canonical Markdown commands and terminal reopen needed. | Durable receipts replay exact payloads once, reject altered command IDs/payloads, and require explicit terminal reopen. `feature-command-replay`, `local-delivery-acceptance-controls`. |
| FR-UI-001 | Active, queued, blocked and review overview | task-overview; worker-capacity | Partial: counts/next actions covered; lifecycle/run/phase separation needed. | Overview adds delivery state/reason plus draft/blocked source projections and four priority levels; presenter tests and desktop/mobile delivery stories cover them. |
| FR-UI-002 | Request details and review workspace | feature-review; worker-review stories | Partial: review view exists; revisions, plan and same-file answers need integration. | Existing review workspace adds behavior, activity, candidate evidence, human decisions and preserved drafts; browser scenarios below determine the exercised interaction boundary. |
| FR-UI-003 | Correlated ordered activity and logs | worker-run-evidence; process-observation | Gap: invocation resource records exist; request/run/step timeline not complete. | Ordered/filterable durable events and separate provider/check displays are present. Correlation uses explicit delivery and invocation identities; final event-specific assertions are recorded below. |
| FR-UI-004 | Precise configuration and controls | tool-access-editor; worker-review stories | Partial: settings/actions exist; step pause, interrupt and reconciliation feedback needed. | Precise step controls, operator-attested recovery, auth-mode setup and effective policy are visible; availability/pending/replay behavior is tested in delivery stories. |
| FR-UI-005 | Daemon continuity and reconnect | webview-smoke; worker-run-evidence | Partial: independent daemon/session reload exists; new command replay and missed timeline need browser test. | Daemon/journal execution survives UI absence and restart; browser replay scenarios retain command identity after a lost acknowledgement. Native reconnect remains pilot work. |
| FR-OPS-001 | Durable recovery | worker-admission-recovery; worker-run-evidence; ready-review | Partial: journals and no-blind-dispatch covered; local commit/package fault matrix needed. | Unknown steps and retained checkpoints survive restart without fabricated success; inspection fences active controllers/services and changed worktree identity. Recovery/control suites plus composed restart. |
| FR-OPS-002 | Retention and redaction | worker-retention; worker-security; provider-account | Partial: bounded/redacted data covered; new artifacts and accepted-evidence retention need audit. | Private raw check output remains separate from public review evidence; provider diagnostic sentinels are redacted and existing retention controls remain. A full live-host secret-handling pilot is not claimed. |
| FR-OPS-003 | Capacity, timeout and budgets | worker-capacity; consumption-runtime; worker-run-evidence | Partial: conservative usage/permit coverage; delivery repair attempts need surfaced limits. | Existing consumption/capacity/timeouts remain in force; delivery repair count and limits are added to the run. Runtime exhaustion tests assert no further model spending. |
| NFR-REL-001 | Interruption across every phase | worker-admission-recovery; development-tasks | Partial: dispatch/result recovery exists; assessment/edit/verify/commit/package matrix required. | All seven phases are covered at persisted journal intent; runtime continuation, real Git checkpoint and provider-stop fixtures add separate boundaries. Native/process crash matrix remains distinct. |
| NFR-REL-002 | Concurrent source integrity | feature-requests; feature-task-notes | Partial: optimistic guards exist; recoverable final replacement race needed. | Guarded replacement and malformed/missing/duplicate source tests preserve content or a recoverable copy; hard-link preflight fails before displacement, and late publication conflicts preserve author text. Generated text never admits work. |
| NFR-REL-003 | Honest pending/known/unknown outcomes | provider-observation; worker-run-evidence | Partial: cleanup fences exist; explicit run-state/UI agreement needed. | Known/pending/unknown outcomes and operator-attested cessation are distinct in journal, transport and UI projections; no confirmation silently dispatches a retry. |
| NFR-PERF-001 | Intake p95 ≤3s | No reference-scale timing evidence | Pending: application benchmark; native reference machine remains unqualified. | Measured 1,000 × 64KiB warm-draft intake p95 1,593ms including 1s delay; all samples/runtime hashes retained. Native/reference-machine qualification pending. |
| NFR-PERF-002 | Startup p95 ≤10s | No reference-scale timing evidence | Pending: 1,000-file reconciliation benchmark with host/payload disclosed. | Measured same-dataset startup p95 592ms; zero invalid inputs. Cold-cache and maximum simultaneously submitted workload are not established. |
| NFR-PERF-003 | UI state p95 ≤2s; preserve focus | worker-review stories; webview-smoke | Partial: interaction fixtures exist; state-to-visible latency and scroll/focus measurements pending. | Desktop/mobile 20-sample UI polling assay and focus/scroll preservation are recorded separately below. A 1s configured poll alone is not acceptance evidence. |
| NFR-PERF-004 | No model polling while waiting | ready-review; feature-continuation; worker-request-gates | Partial: replay/held review cases covered; unchanged delivery waits need call-count test. | Repeated unchanged waiting/exhaustion and recovery observations add no invocation; only explicit supported transitions continue known work. `local-delivery-runtime`, command-replay suites. |
| NFR-SEC-001 | Credential separation | worker-security; provider-account; worker-access | Partial: diagnostics and HTTP redaction covered; new review/commit artifacts need secret sentinel test. | Auth environment isolation and sanitized provider outcomes are asserted with private sentinels; public review notes omit raw check output. No claim of live-host credential qualification. |
| NFR-SEC-002 | Authorized local control | worker-access | Existing focused coverage: HttpOnly, expiry, origin/CSRF, token throttle; rerun pending. | Existing authenticated same-origin request surface handles the new commands; trusted stop observations are not accepted from public payloads. Existing worker-access plus recovery transport tests. |
| NFR-SEC-003 | Trusted authority cannot expand | candidate-tools; tool-runtime; feature-workflow | Partial: frozen authority covered; new command/quality-profile paths need hostile-input cases. | Committed policy snapshots, protected verification inputs, fixed scope/provider authority and trusted recovery observation prevent request-text privilege expansion. Candidate/policy/recovery suites. |
| NFR-USE-001 | What, why, next action and actor | feature-review; task-overview; worker-review stories | Partial: presenters exist; every new blocked state needs accessible primary summary. | Generated region and request workspace disclose current work, blocker, next action and control targets. Delivery stories cover the main blocked states; this is not broad user-study evidence. |
| NFR-ACC-001 | Keyboard, focus, field errors, text status | worker-review stories; webview-smoke | Partial: keyboard/focus fixtures exist; new controls and native browser audit pending. | Keyboard/focus/form-error/text-status checks are exercised in desktop/mobile browser scenarios below. Full native assistive-technology qualification remains separate. |
| NFR-OBS-001 | Request/run/event correlation | worker-run-evidence; worker-request-gates | Partial: durable histories exist; complete delivery-step events needed. | Persisted request revisions, ordered events, delivery steps, invocations, receipts and operator decisions retain correlation/time. Event-specific assertions and final browser evidence are recorded below. |
| NFR-COMP-001 | Versioned UTF-8 artifacts and qualified platform | project-worker; task-notes; feature-workflow | Partial: existing versioned formats; new schema and Windows/Claude version declaration pending. | Versioned UTF-8 requests, policies and review notes retain explicit legacy behavior. Managed-note updates require a writable hard-link-capable local volume. Windows/Claude versions await the native pilot. |
| NFR-DATA-001 | Explicit retention/degraded recovery | worker-retention; worker-security; worker-run-evidence | Partial: conservative workspace retention; lost-state delivery recovery must stay uncertain. | Unknown restart state remains unknown; explicit operator recovery preserves partial-work identity and receipt history. Existing bounded retention persists, with external candidate/review artifacts retained. |

## Scenario traceability

| Scenario | Existing evidence and gap | Required integration observation |
| --- | --- | --- |
| AT-01 | `feature-requests` covers draft/stable duplicate scans; canonical intent missing. | Save draft and repeat submit/events through real intake; provider invocation count stays zero then exactly one. |
| AT-02 | `development-tasks` executes real checks; local branch/commit and mandatory acceptance missing. | Real Git baseline → canonical request → fixture edits → real check → owned commit/review note → explicit current-candidate acceptance. |
| AT-03 | `shared-ready-review`, `feature-task-notes` cover answers/replay; same-file clarification incomplete. | Blocking question ID appears in source/UI, answer creates one semantic revision, no implementation before ready. |
| AT-04 | `candidate-tools` repairs within a model call; worker repair loop absent. | Fail a real check, repair on another invocation, retain both outcomes; exhaust configured count without review-ready. |
| AT-05 | `feature-requests` and `feature-task-notes` cover optimistic conflicts. | Barrier between read and replace; human text survives or recoverable conflict exists; generated region never dispatches. |
| AT-06 | Accepted scope currently freezes. | Edit criterion during active run; old result cannot satisfy new revision; safe reconcile and reassess same identity. |
| AT-07 | Admission, queued recovery and shared outbox fixtures exist. | Crash before/after dispatch receipt and local Git commit; reopen real journal/worktree; count invocations and commits. |
| AT-08 | Provider cleanup and worktree retention tests exist. | Cancel while editing, hold pending until cessation, retain partial diff/checkpoint and show continuing operation when unknown. |
| AT-09 | `local-task-worktrees` asserts real staged/unstaged checkout preservation. | Include staged, unstaged and untracked sentinels and compare HEAD/index/bytes after local packaging and cancellation. |
| AT-10 | API outcome and conservative consumption tests exist; CLI classifications incomplete. | Fixture CLI emits auth-expired/quota/approval stop; no billing fallback or retry loop; native pilot repeats supported cases. |
| AT-11 | `development-verification`, `feature-review` cover stale input/output. | Change candidate, criterion, baseline or check definition; stale decision rejected; missing manual criterion blocks accept. |
| AT-12 | Frozen checks and unapproved edits covered. | Missing tool → unknown; timeout → unknown; approved test weakened → finding; explicit scoped exception never relabels pass. |
| AT-13 | Existing smoke unlock/reload and quiet refresh stories. | Close UI while daemon runs, reconnect to same run/timeline; pause after step prevents next invocation; focus/text retained. |
| AT-14 | Existing rename, duplicate YAML, symlink and missing-file tests. | Canonical ID rename retains history; duplicate/merge marker/missing active source blocks new actions and preserves bytes. |
| AT-15 | Committed baselines are frozen; dependency relationships absent. | Unknown/cycle/unaccepted predecessor blocks; accepted predecessor absent from baseline still blocks; recorded commit incorporation permits. |
| AT-17 | Local patch versus shared publication presenters exist. | Local-only journey uses no fetch/push/remote API; review identifies local branch and commit, never claims a created remote PR. |
| AT-18 | Tool/runtime/access/redaction suites exist. | Hostile request/model text cannot widen tools/gates; credential sentinel absent from logs, Markdown, commits and exports. |
| AT-19 | Operation replay exists; canonical terminal reopen absent. | Same command ID/payload repeats once across restart; changed payload rejects; ordinary edit/submit cannot reopen done/cancelled. |

## Test design and evidence boundaries

Use real temporary repositories, filesystem adapters, request journal and application composition for cross-layer scenarios. Inject only the model protocol at the provider boundary so lifecycle and Git behaviour remain observable. A deterministic model fixture must execute the actual permitted file/check tools; returning a JSON claim of success is insufficient.

Crash tests should place explicit barriers around durable intent, dispatch acknowledgement, check result, commit creation and package persistence, then reopen journals and inspect Git. Assert the number and identity of side effects, retained content and next allowed command. Avoid sleeps as a substitute for known boundaries and avoid assertions that simply repeat a helper's implementation.

Browser tests should exercise the primary journey, stale candidate rejection, pause/interrupt pending states, equivalent Markdown/UI actions and reconnect. Measure state-to-visible delay separately from provider time. Preserve keyboard focus, typed answers and appropriate log scroll through polling. Screenshots are useful evidence only when the page, fixture, viewport and command are recorded.

Performance is an opt-in measurement, not a timing-sensitive default unit gate. The reference is 4CPU cores, 16GB RAM, local SSD and 1,000 requests averaging at most64KB. Retain every sample, p95, warmup policy, dataset size, operating system, Node version, CPU visibility and memory. Container-visible resources do not prove physical reference equivalence. An application intake benchmark does not establish browser rendering latency, real provider latency or filesystem notification reliability.

A native Windows/Claude smoke must record Windows version, Git, Node and Claude versions, declared authentication mode, loaded execution controls, request/run/candidate IDs, real check results and review package. Credentials stay outside artifacts. A simulation or Linux run cannot substitute for this pilot.

## R1 Should and retained later-stage capabilities

FR-RDY-005 (proposed interpretations/permitted assumptions), FR-VER-007 (baseline failure comparison) and FR-UI-006 (behaviour inspector) are useful polishing targets. They must not substitute for explicit answers, weaken mandatory checks, or invent precision. R2 adapters and overrides, the optional reviewer, multi-repository operation and shared publication must retain their established tests; they are not counted as completed R1 acceptance by implication.

## Validation record

The portable implementation now has executed application, journal, filesystem and Git evidence. The baseline matrix remains an account of the starting code, not a blanket final acceptance verdict. **Native Windows with Claude Code is still unqualified.** New evidence below is scoped to the boundaries actually exercised; the PRD's reference-machine and live-provider exit criteria are not waived by these results.

### Application intake measurement

Ran `node scripts/quality/local-intake-benchmark.mjs --count 1000 --samples 20 --bytes 4096` on 2026-10-20 from 12:28:06 to 12:29:22 UTC. [Raw samples and environment](../evidence/local-delivery/intake-1000-4096.json) retain the exact output. The dataset used 1,000 canonical drafts of 4,096 bytes, with YAML comment padding; implementation admission was disabled. Zero invalid files and zero model calls were observed.

| Application observation | p95 | Local planning target | Interpretation |
| --- | --- | --- | --- |
| Startup/reopened-state scan and list | 1,319ms | 10,000ms | Within target on this host. |
| Stable save to application list, including 1,000ms polling delay | 2,234ms | 3,000ms | Within target on this host. |

The host reported Linux x64, Node24.19.0, 4 available CPUs and a 4CPU/16GiB container limit; storage type is unverified. The run used warm filesystem cache and overlapped other implementation/validation activity. It does not establish browser rendering latency, native Windows behaviour, SSD equivalence, or capacity to admit 1,000 maximum-size ready requests. These measurements are application-level evidence for NFR-PERF-001/002; final reference-machine qualification remains pending.

### Maximum raw-file-size measurement

A second run used the same 1,000 drafts and 20 samples, now at 65,536 bytes each
(65,536,000 bytes total), from 12:34:01 to 12:36:11 UTC. [Raw 64KiB samples](../evidence/local-delivery/intake-1000-65536.json)
retain the measured values. The semantic body stayed small; the remainder was
YAML comment padding. All files were valid and no model calls occurred.

| Application observation | p95 | Target | Result on this host |
| --- | --- | --- | --- |
| Startup/reopened-state scan and list | 2,414ms | 10,000ms | Within target. |
| Stable save to application list including 1,000ms scheduling delay | 4,246ms | 3,000ms | **Above target; optimization/retest needed.** |

This run overlapped other validation activity and does not establish controlled
reference-machine performance. The slow observation remains a finding rather
than being removed or averaged into the smaller-dataset result. The application
list performs reconciliation and an additional full folder scan; this duplicate
work is an identified optimization candidate. Any later retest must retain this
baseline and state the implementation or environment change.

### First optimization retest

After reusing the completed intake scan for the list projection, the same 1,000 ×
65,536-byte, 20-sample measurement completed from 12:43:20 to 12:44:34 UTC.
[Retest samples](../evidence/local-delivery/intake-1000-65536-optimized.json) retain
all observations. Startup p95 fell to **1,109ms** and save visibility p95 to
**3,050ms**. All inputs remained valid and no model was invoked. Visibility still
exceeded the 3,000ms target under overlapping validation activity; this retest
therefore did not close the performance finding. The quiet final measurement
below follows this run; native pilot qualification remains separate.

### Final intake measurement after parse caching

The frozen worker build was measured in a coordinated quiet interval from
13:02:09 to 13:02:55 UTC. The dataset and sampling method were unchanged:
1,000 canonical drafts × 65,536 bytes, 20 startup samples, 20 save observations,
a warm filesystem cache and a 1,000ms scheduling delay. The optimization keeps
reading and hashing every file; only unchanged parsing results are reused. It
also keys those results by effective provider, so configuration changes cannot
reuse an obsolete input projection.

[Final samples and build fingerprints](../evidence/local-delivery/intake-1000-65536-final.json)
record every sample, the host limits and SHA-256 hashes of the four measured
intake modules. The script checks those hashes again at completion and refuses a
measurement whose runtime files changed while running.

| Application observation | p95 | Target | Result on this host |
| --- | --- | --- | --- |
| Startup/reopened-state scan and list | **592ms** | 10,000ms | Within target. |
| Stable save to application list including 1,000ms scheduling delay | **1,593ms** | 3,000ms | Within target. |

Zero malformed inputs and zero model invocations were observed. Earlier failing
samples remain above for comparison. This closes the measured application-level
performance finding for this warm-cache draft dataset on this Linux host. It
does not qualify a browser, Windows, real provider execution, a cold filesystem,
or 1,000 concurrently submitted maximum-size requests. The native reference
machine remains an explicit qualification step.

### Composed request-to-acceptance journey

`tests/worker/local-delivery-workspace.test.mjs` passed four composed regressions,
alongside seven installed-project cases (**11 passed, zero failures/skips**).
[Raw installation and workspace output](../evidence/local-delivery/portable-workspace-tests.txt)
records the cases. The complete portable journey runs using the real `WorkerWorkspace`, canonical folder intake, SQLite
journals, Git, candidate tools, command verification and local delivery adapter.
Only the model protocol is injected. The fixture applies an approved source edit
through the production candidate tool; an actual Node command checks the result.

The uppercase `FR-0042` identity produces one durable implementation invocation,
an isolated worktree and owned candidate branch/commit, a passing check receipt
and a local review note. Restarting in review does not redispatch the model or
append duplicate lifecycle events. Per-criterion human acceptance enters through
the actual Markdown grammar; restarting the accepted request preserves that
decision and consumes no additional model work. The original checkout's HEAD,
staged tree, staged and unstaged diff, and untracked sentinel remain unchanged.
The fixture has no Git remote and rejects every HTTP attempt; the result is a
local candidate and review note, not a remote pull request. This establishes the
portable application boundary for AT-02/09/17 and part of AT-01/07/11/19. The
other composed cases show that priority changes reorder paused work without a
new requirement generation, removing acceptance criteria clears the old criteria
and blocks the same request at DoR, and an external candidate edit withdraws
review eligibility without redispatch or stale acceptance. Old per-run review
artifacts remain immutable; a new generation cannot retain them as its current
result. These tests do not establish live model quality, account eligibility or
Windows operation.

### Safety acceptance assertions

The combined recovery command passed **35 tests, zero failures and zero skips**:

```sh
node --test tests/worker/local-delivery-acceptance-controls.test.mjs tests/worker/local-delivery-runtime.test.mjs tests/worker/local-delivery-recovery-inspection.test.mjs
```

[Raw test output](../evidence/local-delivery/portable-recovery-tests.txt) retains
individual results. The control suite contributes 25 cases including seven phase
subtests; six runtime cases and four recovery-inspection cases exercise bounded
repair, known-result continuation and inactive-workspace preflight.

The control cases use the real SQLite journal with deliberately synthetic
trusted-runtime review packages. They cover behaviour priority, idempotent step
observation, pause boundary/resume, exact command replay, known versus unknown
stop, terminal reopening, source holds/material revisions, candidate-bound
manual acceptance, exact checkpoint identity and withdrawal of stale review
eligibility. Missing-package and omitted-candidate acceptance bypasses exposed by
the first run are fixed and now reject without a success receipt. The
parsed-Markdown case verifies real command translation, including generated
human-criterion IDs and stable command identity.

Restart coverage spans assessing, planning, preparing, implementing, verifying,
repairing and packaging **at the persisted journal-intent boundary**. Each case
retains the uncertain operation ID and blocks blind replay. This is not a claim
that every possible OS/process or Git crash boundary was exercised. Explicit
`confirm_stopped` tests require a matching trusted workspace observation and a
nonempty operator note, reject stale/forged observations, preserve unknown
historical outcomes, replay once across restart and require a separate resume.
Pending cancellation resolves only after that explicit recovery decision.

The later broad-suite run also exercised explicit event correlation assertions:
step-start, step-complete and operator-confirmed-stop events retain the exact
`deliveryRunId` and `deliveryStepId`, while `runId` keeps its existing provider
invocation meaning. Its aggregate result is recorded below.

### Admission and source-integrity regressions

The final focused admission/runtime/recovery run passed **86 tests, zero failures
or skips**, including all **13 new canonical admission cases**.
[Raw focused output](../evidence/local-delivery/portable-admission-tests.txt)
records the individual results. Canonical exact-file delivery rejects missing
file grants, required/enabled checks, execution services and mismatched committed
baselines before snapshots or model preparation. Restoring configuration reuses
the same reservation once; interrupted admission retains its failed receipt.
Legacy exact-file proposals retain their existing admission behavior and are not
silently selected for canonical delivery.

A separate 20-case source/reconciliation/composed/provider-selection run passed
19 cases and exposed one fixture error: it tried to change tool access without
pausing new starts. The fixture now follows the real pause/configure/unpause
contract; [its isolated rerun passed](../evidence/local-delivery/portable-admission-recovery-test.txt).
The [original focused output](../evidence/local-delivery/portable-source-review-tests.txt)
is retained, including that intermediate failure. The composed regression shows
a request with no required check stays held, then reaches review under the same
Feature Request and input revision after authorized configuration. It uses real
filesystem/Git/check paths and an injected model, not a live provider.

The same focused run passed three recoverable-write cases: unsupported hard links
leave the original note in place, a late editor save wins while old content stays
recoverable, and a colliding preflight path is not deleted. Managed-note updates
therefore require writable hard-link-capable local storage. The injected failure
cases establish safe handling on Linux; they do not qualify a Windows volume.

### Browser interaction and state visibility

The replacement targeted Chromium run passed **50 desktop/mobile scenarios**,
covering all existing Worker/Review scenes as well as delivery, setup and defaults.
There were no reported console/page errors. The scenes exercise provider
configuration, active work, pause, uncertain outcomes, operator-attested stops,
lost acknowledgements, human criteria, draft preservation, activity filtering
and stale or ownership-conflicting acceptance attempts.
[Scene results](../evidence/local-delivery/browser-targeted-results.json) and
[browser/source provenance](../evidence/local-delivery/browser-provenance.json)
identify the exact fixture boundary. The targeted run used a working-tree UI
follow-up to commit `fe792f4`, identified by its own source digest; it is separate
from final whole-catalogue source qualification. Representative renders show
retained checkpoints, historical evidence and the explicit operator-attestation
receipt on [desktop](../evidence/local-delivery/recovery-desktop.png) and
[mobile](../evidence/local-delivery/recovery-mobile.png). The pages visibly label
this as illustrative data, with no model, command, Git change or review performed.

Visual review exposed a gap in the earlier interaction checks: an interrupted
current delivery could inherit completed milestones, a review package or output
text from an older interaction or patch. Generic queue actions also duplicated
the delivery controls. Current milestones and review authority now require the
matching delivery run, accepted input and policy; older patches, checks, packages,
DoD gates and invocation text remain explicitly historical. Delivery continuation
uses its exact guarded controls. The strengthened fixtures deliberately retain
older results beside an interrupted or unknown current run.
[All 36 focused presenter/control tests passed](../evidence/local-delivery/portable-review-projection-tests.txt),
and Vue typechecking passed after the final caption correction. Stale or
ownership-conflicting reads keep drafts editable while blocking both ordinary
and directly dispatched acceptance submission.

A separate assay changed the coherent fixture response revision 20 times per
viewport and observed the marker through the actual one-second UI polling path.
[All 40 replacement samples](../evidence/local-delivery/browser-latency.json)
retain timing, focus, draft and scroll observations. Nearest-rank p95 is the
19th ordered sample of 20 for each viewport.

| Viewport | Samples | State-to-visible p95 | Maximum | Focus/draft/scroll |
| --- | --- | --- | --- | --- |
| Desktop, 1440 × 1000 | 20 | **1,023ms** | 1,029ms | Preserved in every sample; 0px scroll/editor-position change. |
| Mobile, 390 × 844 | 20 | **1,014ms** | 1,023ms | Preserved in every sample; 0px scroll/editor-position change. |

An earlier assay exposed a separate defect: a transient stale snapshot disabled
the human-review fieldset and removed keyboard focus. The fix keeps draft editing
available while preserving freshness checks on consequential actions; the final
40-sample run above retains focus. The measurement covers a local Linux Chromium
Storybook fixture response-to-render boundary, with reduced motion and external
network blocked. It excludes a real daemon, provider, native Windows, network
latency, production load and assistive-technology qualification. The p95 result
supports NFR-PERF-003 at that declared boundary, not a universal service guarantee.

Full Storybook catalogue qualification subsequently passed at committed UI
revision [90d44f7](https://github.com/Luis85/production-line/commit/90d44f7792122cf03bc9fc84ca997f84558e5a65):
**98/98 components, 238 stories and 476 desktop/mobile screenshots**. Documentation
checks passed for **70 pages and 6,573 links**, with zero qualification errors.
Its source digest, `20cce8a446c7875951a41f68424023f2469fc14234f3706203351730849aa25a`,
matches the retained targeted-browser evidence above. This qualifies the UI code
at `90d44f7`; the later platform-test fixture corrections below are a separate
follow-up and are not claimed to have existed in that captured commit.

### Project quality gates and remaining aggregate validation

The [fast project gate](../evidence/local-delivery/portable-quality-fast.txt)
passed README drift checks, Oxlint, source and Vue typechecking, and test
source-contract checking (**434 maintained test files, 1,022 imports, zero
errors**). All **1,014 files** stayed within the 400-source/450-test code-line
limits. The architecture suite passed **19 assertions**. Fallow reported zero
new dead-code or architecture findings and retained its **175 individually
reviewed baseline findings**; retained findings are not a clean-slate claim.

The broad local `npm run check` attempt produced **2,795 tests: 2,778 passed,
2 failed and 15 skipped**. The failures were stale assertions in
`feature-requests.test.mjs` (an invalidated input must not retain a current result)
and `model-selection.test.mjs` (the frozen selection error now also names the
authentication mode). After correcting those expectations, the
[request-projection suite passed all 21 cases](../evidence/local-delivery/portable-request-projection-tests.txt),
and all four model-selection cases passed in the focused source review above.
Those resolving runs are not represented as a rerun of the entire broad local
suite. The 15 local skips were platform- or tool-dependent cases.

The first combined implementation commit, `fe792f4`, subsequently passed
[Ubuntu aggregate CI](https://github.com/Luis85/production-line/actions/runs/39432878358/job/118662190574):
**2,812 tests, 2,798 passed, 14 skipped and zero failures**, in 452.84 seconds.
Skip counts differ with the runner's platform and installed tools. This proves
the first implementation commit; it does not include the later UI corrections.
At this evidence snapshot, their aggregate commit-level CI was still pending.
The focused UI and browser results above record the completed follow-up checks.

The same first implementation commit's
[Windows aggregate CI](https://github.com/Luis85/production-line/actions/runs/39432878358/job/118662190821)
finished with **2,812 tests: 2,699 passed, 9 failed and 104 skipped**, in 42m23s.
The subsequent corrections are confined to test fixtures: close provider resources
before deleting their files, recognize Claude's default JSON authentication-status
output, use bounded per-attempt Windows execution budgets, and allow the mock
fleet's three bounded execution waves. Dedicated repair guards still assert four
invocations, three repairs and no replay; unrelated guards explicitly disable
repairs they do not test.

After these corrections, local Linux regressions passed **18/18 development
cases**, **9/9 orchestrator runtime cases**, and **11 provider cases with 7 Windows-only
skips**. The fast gate passed again with the same file/import counts above.
These results do not replace the Windows run: corrected native Windows CI was
still pending at this snapshot, and a live Windows/Claude account pilot remains
unqualified. No runtime or UI code changed in this fixture follow-up.

The retained packaged installation/interaction journeys also passed with
[Node on Linux](../evidence/local-delivery/packaged-node-smoke.json) and
[an actual Docker runtime](../evidence/local-delivery/packaged-docker-smoke.json).
Their outputs preserve installation, intake, guarded interaction and restart
observations. Both explicitly report `liveProvider: false`; these protocol-fixture
smokes do not qualify a real Claude account or native Windows execution.

### Scoped advisory mutation baseline

The completed `worker-local-delivery-v4` experiment covers **12 modules** with
104 focused contract tests. Its [recorded baseline](../../scripts/mutation/baseline.json)
completed in **160.9 seconds** with a **96.34%** Stryker score across **1,639
mutants**: **1,562 killed, 17 timed out, 58 survived and 2 uncovered**, with zero
compile/runtime errors or ignored mutants. Timeout detections are part of
Stryker's denominator and detection count; they are not assertion kills.

[All 60 surviving or uncovered findings](../../scripts/mutation/survivor-review.json)
retain individual classifications and rationale. Three explicit assertion gaps
remain: Unicode case-fold distinctions, a one-character approved filename, and
a persisted baseline supplied as a one-item JSON array. The two uncovered
branches also remain visible. No mutant or scored module was excluded to raise
the result. Earlier scopes remain archived and their percentages are not directly
comparable with this expanded scope.

The baseline binds source, compiled dependencies, tests, configuration and report
digests to the measured working tree; it does not claim a committed or live
provider execution. Its report digest is
`2bac2916d45a6a166e4f4cf103533384705a3e6265a3df83e72f245826a51337`.
Mutation remains an advisory release experiment, separate from normal development
tests. It does not measure the entire application, Git/process integration or
Vue interaction coverage; the other evidence in this ledger covers those
boundaries separately.

| Evidence | State | Qualification limit |
| --- | --- | --- |
| Source/requirement audit | Recorded above; all 69 required IDs mapped | Test assertions inspected; not an execution result. |
| New local delivery integration tests | 35 recovery/control tests pass; composed request-to-acceptance journey passes | Real journal/Git/check fixtures prove application rules; the model protocol is injected. |
| Full project quality/build/test gates | Fast gate passes; initial Ubuntu CI passes; initial Windows CI records 9 failures followed by locally passing fixture corrections | Corrected native Windows CI and the live Windows/Claude pilot remain pending at this snapshot. |
| Advisory mutation baseline | v4: 96.34%; 1,562 killed / 17 timed out / 58 survived / 2 uncovered across 12 modules | All 60 remaining findings retained; scoped working-tree measurement, not whole-project or native-provider qualification. |
| Application intake benchmark | Final 64KiB startup p95 592ms; save visibility p95 1,593ms | Earlier failures retained; warm Linux drafts only, no browser/reference/pilot claim. |
| Browser control/replay/focus journey | 50 scenarios and 40 replacement state-visibility samples pass; p95 1,023/1,014ms | Linux Chromium Storybook fixtures; real daemon/network/Windows and assistive technologies remain distinct. |
| Full Storybook catalogue | At `90d44f7`: 98/98 components, 238 stories, 476 screenshots, 70 documentation pages and 6,573 link checks pass | Same measured UI source digest; later test-fixture changes have separate CI qualification. |
| Native Windows with Claude Code pilot | Pending external environment | This managed execution host is Linux and has no authenticated Claude binary. |

## Reproduce the benchmark and native pilot

After building source with Node24, run the benchmark directly; it is intentionally outside the default test gate:

```sh
node scripts/quality/local-intake-benchmark.mjs --count 1000 --samples 20 --bytes 4096
node scripts/quality/local-intake-benchmark.mjs --count 1000 --samples 20 --bytes 65536
```

Capture stdout as a JSON artifact. File payload, warmup/cache policy, sample count, raw timings, measured runtime hashes and host/container observations are included. The benchmark fails on invalid or incomplete intake; it never treats skipped/malformed inputs as a faster successful scan. No model is invoked. `--poll-ms` declares the scheduled delay included in save visibility. Browser latency and provider time need their own measurements.

On the selected native Windows machine, first save the intended Claude provider configuration with `authenticationMode: cli-account` or an explicit private API-key mode. From the source checkout, run:

```powershell
node scripts/runtime/provider-diagnostics.mjs --provider claude-cli --executable "C:\path\to\claude.exe" --authentication-mode cli-account
```

This is a read-only status/version/capability probe, not inference qualification. Preserve its sanitized JSON, including `liveInferenceQualified: false`. Then use a disposable committed project with a failing deterministic check and a bounded Feature Request to exercise AT-01/02/04/07/08/09/10/11/17/18/19. Record actual runtime versions, auth mode, Git baseline/candidate, request/run IDs, process cessation, checks, Markdown handoff and explicit human decision. Do not copy credentials into the evidence. Keep tests that require provider limits or account expiry explicitly unexercised when those conditions were unavailable.
