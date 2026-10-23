# Local delivery implementation review — 2026-10-21

## Scope and method

This review covers the complete local delivery implementation on PR #50, starting at `9bef6610c06251cc70061471c7cc34092eab499a`. It follows the [80-requirement, 19-scenario acceptance ledger](2026-10-20-local-delivery-acceptance.md), including R1, R2 and R3. Six independent reviewers examined architecture, Feature Request lifecycle, provider/process runtime, UX, tests/mutation and documentation. The orchestrator integrated the fixes and reviewed their shared contracts. No release or version change is part of this pass.

The review combined source tracing, reproduced failures, focused behavioral tests and fresh desktop/mobile browser captures. It did not reclassify historical benchmark results or protocol fixtures as live provider qualification. Current CI results are attached to the PR's exact head; the baseline already had successful checks and release validation before this pass.

## Findings and improvements

| Perspective | Reproduced issue | Implemented improvement and regression evidence |
| --- | --- | --- |
| Architecture and routing | A routing rule could refer to an absent quality profile and silently fall through to another execution choice. | The complete project-policy validator rejects unresolved references before draft approval or admission. `delivery-policy-routing.test.mjs` covers invalid and valid custom profiles, unconditional routing and immutable snapshots. |
| Workflow correctness | An unrelated duplicate request in another project's catalog blocked an independent dependency plan. Intermediate nodes could appear ready while a transitive prerequisite was unaccepted or unintegrated. | Duplicate checks apply to the reachable graph; dependency holds propagate through intermediate nodes while actual incorporation receipts remain visible. `delivery-dependency-plan.test.mjs` covers independence, reachable duplicates and all three unavailable-prerequisite cases. |
| Input and authority boundaries | Array-valued enum fields such as `[eq]`, `[prepare]` or `[pass]` passed string-coerced validation but later took different branches. | Exact string validation now protects gate operators/input kinds, canonical Markdown intent/mode/priority, controls and decisions, authoring commands, request identities and reviewer findings. The existing validators remain the common entry points; no parallel workflow was added. `request-gate-validation.test.mjs` and `feature-input-boundaries.test.mjs` include malformed and valid inputs. |
| Durable provider sessions | Cancellation inside the final pre-call callback could mark a session unknown despite zero inference dispatches. | Every affected adapter rechecks cancellation before marking dispatch and restores the prior checkpoint for proven unstarted work. `runtime-dispatch-boundary.test.mjs` tests initial and subsequent turns, zero extra inference calls and explicit continuation across five adapters. |
| Configuration and restoration | Coercible model-session states, MCP transports and saved definition providers survived validation; null catalog entries raised an incidental TypeError. | Strict boundary validation rejects malformed saved/configured data. Definition restoration validates the whole catalog before exposing it and reuses the snapshot contract. Restoration, duplicate identities, immutable selections and no-write behavior have regressions. |
| Interaction stability | A same-request revision refresh replaced the publication panel with loading text, losing its expanded disclosure. | See the [fresh UI audit and polishing report](2026-10-21-worker-ui-review.md) for the snapshot revalidation fix, stale-action fencing, responsive evidence and confirmation checks. |
| Test effectiveness | One large readiness suite caused TAP mutation selection to repeat unrelated integration scenarios. | The same 21 test bodies are organized into cohesive lifecycle, publication, selection and recovery suites with a shared fixture. The 24 production mutation targets remain intact; new routing and nested native-startup hold assertions cover the reviewed behavior. See [mutation testing](../how-to/mutation-testing.md) for current measurements and limits. |
| Onboarding and product contracts | Setup guidance described legacy notes, omitted committed-policy approval and retained single-slot/no-project-tests claims. | Installation and first-delivery guides now follow canonical drafts, policy commit/approval, submission and human review. Product/design/reference guidance describes configured capacity, current controls and optional publication. Both READMEs are generated from the maintained overview. |

## Reviewed invariants

The canonical Feature Request remains the shared entity for Markdown, chat and CLI intake. The review traced semantic revisions, duplicate/source holds, command receipts, readiness decisions, isolated worktrees, candidate-bound checks, dependency incorporation and human acceptance. Existing replay, stale-write, protected-input and uncertain-outcome protections remain in place.

Provider and process review covered API/CLI authentication boundaries, durable session fencing, process/service ownership, Windows native preparation and shutdown. Cancellation before dispatch is distinguished from uncertain completion after dispatch; the latter still requires explicit reconciliation. Default execution deadlines and consumption limits were not relaxed.

The architecture retains application policy behind injected ports and adapters at the edges. Fixes sit in existing contract validators and shared state handling. Independent reviewers checked the definition restoration, dependency propagation, runtime cancellation and UI freshness changes; none introduced a second intake or execution service.

The UI audit uses the existing product identity and navigation. It covers setup, new requests, capacity/queue, readiness, review, metrics and settings at desktop/mobile sizes. Screenshot evidence supports specific visual/interaction findings; it does not establish full accessibility compliance or a user-study outcome.

## Consolidated validation

The final source checks passed after implementation freeze: 1,163 source/test/helper files meet the 400/450 code-line limits; Oxlint is clean; Fallow reports zero new dead-code or architecture findings with 177 reviewed baseline findings retained; 1,253 generated import mappings agree; all 19 architecture assertions pass. Application/Vue typechecking passes, and all 497 maintained test/support files are typechecked against 1,244 source imports with zero errors.

Focused behavioral verification passed 48 policy/journal/definition tests, 63 lifecycle/Git tests and 25 current-source provider-session tests. These runs overlap and are not added into a claimed unique total. The final coordinated rebuild is the source for consolidated full-suite validation; an earlier runtime check against stale compiled cancellation code is excluded from passing evidence.

The UI reviewer captured and inspected 16 baseline and 20 confirmation cases; all confirmation cases and 12 snapshot lifecycle/race tests pass. The final Storybook catalogue is qualified separately in CI. The mutation contract suite passes 170/170. The one-target policy diagnostic completed in 95.2 seconds with 318 mutants (277 killed, 33 survived, eight uncovered, no timeouts); it predates the final routing and policy-propagation coverage additions and is not the full v5 baseline.

Both READMEs are regenerated from their source. Documentation command checks and strict vault validation pass. The exact-head full-suite, cross-platform, packaging and catalogue results are recorded on [PR #50](https://github.com/Luis85/production-line/pull/50), avoiding a checked-in CI receipt that becomes stale when committed.

## Remaining qualification boundaries

The selected native Windows with an authenticated Claude Code account remains a separate pilot. Linux contained CLI/API protocol fixtures, native package smoke tests and Windows CI do not establish real account eligibility, live model outcomes or every vendor runtime restriction. The full live provider matrix, live remote publication, reference-machine performance and assistive-technology qualification also remain distinct.

Mutation results are bounded release diagnostics. A completed single-target diagnostic must not be presented as a completed v5 score for all 24 targets; the older v4 score remains historical. Mutation testing stays outside normal development checks and advisory in the release pipeline.
