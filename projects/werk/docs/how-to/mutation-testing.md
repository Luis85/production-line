# Review mutation testing results

Mutation testing changes production expressions in an isolated sandbox and checks whether tests notice. Werk uses pinned StrykerJS 10.0.0, its TAP adapter and Node 24. Mutation testing remains advisory. A bounded workflow scope runs on pull requests and releases; the broader authority scope runs on releases. Ordinary local development checks do not invoke Stryker.

## Current measurement status

The completed [workflow v2 follow-up](https://github.com/Luis85/production-line/blob/124f6d9d2a1200b9f617aee4aa853ce95ea75863/projects/werk/docs/evidence/local-delivery/mutation-workflow-v2-followup-2026-10-25/README.md) covers **19 modules and 2,955 mutants: 2,474 killed, 401 survived and 80 uncovered**, with zero timeouts or errors, in 429.367 seconds. Its scoped Stryker and assertion-killed scores are both **83.72%**. Thirty additional contracts raised the selected suite to 103 passing tests and added **138 assertion kills** over the initial 79.05% measurement, preserving all original kills. The exact production sources, mutant universe and measurement configuration are unchanged. Every remaining finding and status transition is retained; no baseline was promoted, survivor excluded, mutant deadline extended or threshold reduced.

The full `worker-delivery-authority-v5` scope completed on the tagged **v0.15.0** release at commit `9b2db009d23b5e677a3650227ba8f990ca813d27`: **24 modules, 3,881 mutants and a 91.03% scoped score** in 476.795 seconds. The counts are 3,493 killed, 40 timed out, 328 survived and 20 uncovered, with no compile/runtime errors, ignored or pending mutants. The overall run completed normally; Stryker counts individual-mutant timeouts as detected, separately from assertion failures.

The [durable release evidence](https://github.com/Luis85/production-line/blob/85471615318805132cfe67f3169670253c97f908/projects/werk/docs/evidence/local-delivery/mutation-v5-v0.15.0/README.md) retains the exact summary, raw report and tool log with artifact checksums. All 348 surviving or uncovered findings remain visible and in the denominator. This is a completed measurement, not a claim that those findings have received individual review or that the whole repository has been mutation-tested.

The configured comparison baseline remains the individually reviewed `worker-local-delivery-v4`: 12 modules, 1,639 mutants, 96.34% scoped score, 1,562 killed, 17 timed out, 58 survived and two uncovered. Its [baseline](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/baselines/worker-local-delivery-v4.json) and [survivor review](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/baselines/worker-local-delivery-v4-survivors.json) remain immutable historical evidence. The different scope prevents a direct score comparison. The v5 measurement does not silently replace `scripts/mutation/baseline.json`; promotion requires the individual review described below.

Earlier v5 attempts did not complete. The attempt at `781b1a1aafc7b833b473fc2aaf3da9a3c02e824e` reached its twelve-minute tool limit after 721.6 seconds and produced no final score. Its [attempt summary](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/attempts/worker-delivery-authority-v5-781b1a1.json) and [progress log](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/attempts/worker-delivery-authority-v5-781b1a1.log) remain unchanged. Partial counts from those attempts are not a final denominator; the completed tagged measurement is separate evidence.

## Run the advisory checks

From `projects/werk` in a source checkout:

```sh
npm ci
npm run mutation:contracts
npm run mutation
npm run mutation -- --scope workflow
```

`mutation:contracts` runs observable contract tests without mutation. It reuses serialized-operation, SQLite consumption, Ready Check, criterion-decision, concurrency, execution-policy and check-pack tests, plus focused private approval, behavior, dependency and execution-recovery suites. `mutation` returns failure for tool errors or incomplete evidence. A low score or surviving mutant does not fail qualification.

The usual `npm test`, `npm run check` and builds do not invoke Stryker. Pull requests have a separate advisory workflow-mutation job; its result does not replace the normal checks. Downloaded runtime archives remain prebuilt and do not contain a requirement to install mutation tools.

`npm run mutation:release` reports incomplete runs and tool errors as warnings. The release workflow runs it as an independent advisory job: publishing does not depend on that job. Setup, install, execution, report-upload and job failures remain visible in workflow summaries and annotations. The job has its own overall deadline.


## Workflow mutation scope

`npm run mutation -- --scope workflow` measures `worker-workflow-v2` independently of the historical authority scope. It covers 19 modules: the existing release/publication/rework boundaries, neutral candidate acceptance, delivery-policy parsing, local main-checkout merge view/runtime/contracts/journal, completion/retention the next-increment baseline guard, effective frozen shared gate policy and shared local-merge phase projection. The selected policy contract suite is included explicitly and fingerprinted; the workflow lane also reuses the ordinary local merge SQLite-journal scenarios. Its fixed twelve-minute budget and selected contracts make current workflow failures visible without rerunning the entire authority denominator on every pull request.

The workflow contracts independently construct accepted and rejected states. Local merge tests require an explicit accepted `localMerge: true` policy, exact candidate/run/input/policy identity, persisted preparation before checkout mutation, read-only unknown-outcome recovery, and inclusion of every prior accepted merge in the next shared baseline. They fence stale candidate/input/policy/output identity, unknown execution and unresolved holds, same-request PR ownership, bounded feedback history, source confirmation before dispatch, replay after restart, and completion only after a published-release receipt. The measured run also reuses ordinary release/publication runtime and SQLite-journal scenarios. Fixtures perform no live provider inference or GitHub mutations.

The default `npm run mutation` still selects `worker-delivery-authority-v5`; `--scope authority` selects it explicitly. Unknown scopes and duplicate/malformed options fail rather than silently reducing coverage. Each sandbox receives the same scope as its owning runner. Generated-import checks accept only targets in the registered named scopes, and test provenance includes the selected suites and their reusable helper files.

Workflow reports are under `reports/mutation/workflow/`; authority reports retain their existing `reports/mutation/` paths. Starting one scope removes only that scope's report files, preserving other measurements. Both jobs upload their own artifacts even on incomplete runs. The `werk-mutation-workflow-report` artifact runs for PRs as well as releases; `werk-mutation-report` retains the broader release-only measurement. Publication waits for neither advisory job.

Summaries now disclose an **assertion-killed score** (`Killed / valid mutants`) alongside Stryker's timeout-assisted score (`(Killed + Timeout) / valid mutants`). The denominator includes every surviving and uncovered mutant. Runtime errors, pending results, provenance mismatches and incomplete runs stay explicitly unavailable; compile errors remain separately counted and excluded by Stryker’s denominator; no survivor exclusions or adjusted scores are introduced. The historical baseline is not automatically replaced when measuring the new scope. Compare only measurements with compatible scope and configuration provenance.

The earlier nine-module v1 [workflow measurement and remaining-findings review](https://github.com/Luis85/production-line/blob/e75261c54fc6939e181636b0f59f3bddb8a98035/projects/werk/docs/evidence/local-delivery/mutation-workflow-v1-2026-10-25/README.md) retain both actual runs: assertion refinement raised kills from 1,168 to 1,475 of the same 1,880 mutants (62.13% to 78.46%), with no timeouts or exclusions. All 345 survivors and 60 uncovered mutants remain visible; no workflow baseline is promoted. The expanded v2 scope retains its [initial completed receipt and 619-finding review](https://github.com/Luis85/production-line/blob/ad5c40cd70bb27b5b64f79c918b034f3a1c1c9c4/projects/werk/docs/evidence/local-delivery/mutation-workflow-v2-2026-10-25/README.md) and the [same-scope follow-up with all 481 remaining findings](https://github.com/Luis85/production-line/blob/124f6d9d2a1200b9f617aee4aa853ce95ea75863/projects/werk/docs/evidence/local-delivery/mutation-workflow-v2-followup-2026-10-25/README.md). The 79.05% to 83.72% comparison uses identical v2 sources and configuration; v2 has a different denominator from v1. A scoped measurement is evidence about those selected authority boundaries, not a whole-repository score or native Windows/Claude qualification.

## Scope and limits

| Selected source module | Contract under test |
| --- | --- |
| `src/shared/serialized-operations.ts` | FIFO execution, independent failures and drain snapshots |
| `src/shared/request-gate.ts` | Bounded, consistent and private-safe completion receipts |
| `src/shared/http/response-body.ts` | Byte limits, reader ownership and cancellation |
| `src/shared/webview/bounded-polling.ts` | Active-view polling, overlap prevention and cancellation |
| `src/worker/application/consumption.ts` | Whole-token shares, UTC windows, reservations, cumulative usage and fail-closed admission |
| `src/worker/application/delivery-policy.ts` | Committed quality profiles, immutable baselines, protected inputs and mandatory readiness rules |
| `src/worker/application/delivery-policy-approval.ts` | Exact private repository/configuration approval, revision guards and bounded history |
| `src/worker/application/delivery-criterion-decisions.ts` | Candidate-bound human exceptions, exact criterion permissions and immutable identity |
| `src/worker/application/delivery-verification-eligibility.ts` | Observed checks stay distinct from current authorized exception eligibility |
| `src/worker/application/delivery-coordination.ts` | Project limits intersect machine limits; serial defaults remain compatible |
| `src/worker/application/serial-executor.ts` | Shared live and unresolved capacity, project ceilings, exclusive auxiliary work, cancellation and pause |
| `src/worker/application/execution-recovery.ts` | Exact grounded run attestation, immutable operation identity and separate continuation |
| `src/worker/application/delivery-dependency-plan.ts` | Bounded acyclic plans, acceptance versus baseline incorporation, and cross-project receipts |
| `src/worker/application/delivery-execution-policy.ts` | Named providers, billing boundaries, explicit overrides and bounded fallback policy |
| `src/worker/application/delivery-execution-snapshot.ts` | Frozen profile/definition catalog and exact routing receipts without authority substitution |
| `src/worker/application/delivery-execution-routing.ts` | Ordered all-condition routing, authorized overrides and deterministic defaults |
| `src/worker/application/delivery-behavior-policy.ts` | Reusable declarative profiles preserve safety precedence and reject executable grammar |
| `src/worker/application/delivery-check-packs.ts` | Versioned reusable references to existing granted checks; no extra command authority |
| `src/worker/application/delivery-retention.ts` | Temporary-log expiry cannot remove accepted receipts or unfinished work |
| `src/worker/infrastructure/journal/consumption.ts` | Real SQLite accounting, restart recovery and durable charges |
| `src/worker/infrastructure/responses.ts` | Assignment authority, complete input, context pins and durable acknowledgement identity |
| `src/worker/application/ready-review-protocol.ts` | Strict findings, blocking questions, bounded responses and untrusted review context |
| `src/worker/application/shared-ready-review.ts` | Claim-before-payment, explicit re-review, revision fencing, restart holds and deterministic DoR handoff |
| `src/worker/infrastructure/features/review-eligibility.ts` | Structural admission, safe repository scope, authored metadata and source bounds |

This scope is not a whole-repository score or proof of live model execution. Provider subprocesses, Git worktrees, broader application services, metrics projections and Vue rendering remain outside the scored targets. Ordinary integration and release checks qualify those paths separately. In particular, mock-provider tests do not qualify the Windows and Claude Code pilot.

The completed tagged run records 379 compiled TypeScript inputs, 28 test/support inputs and seven measurement-configuration inputs. The provenance collector and compiler share discovery rules: worker webviews, `dist`, `public`, `node_modules` and declaration-only files are excluded. Scored source, compiled dependencies, test membership and measurement configuration are hashed before and after the run. Changing any measured input invalidates an otherwise completed score. The retained raw report matches its summary digest and all 24 scored-source hashes; every recorded input hash also matches the tagged commit. Earlier incomplete reports retain their own provenance limits.

## Earlier incomplete runs and test-selection improvements

The pinned TAP adapter selects and measures entire test files. It starts a new Node process for each selected file and uses the file path as the coverage/test identity; nested Node test cases do not become independent selection units. Adding `--test-isolation=none` therefore would not change its selection granularity.

The composed `shared-ready-review.test.mjs` file was repeatedly selected as a whole, rerunning its composed scenarios for each selected mutation. The observed long-running child processes were doing work, rather than merely waiting for timeout. The first two-worker attempt exceeded the twelve-minute cap. A second attempt used three workers on a four-CPU environment with approximately 17.6 GiB RAM and added progress reporting; it also did not complete. Targets, assertions and individual-mutant deadlines were unchanged. Neither attempt produced a score.

The follow-up review splits all 21 composed scenarios into lifecycle, publication, recovery and provider-selection files, sharing the same fixture. Every original test body is preserved. The TAP adapter can now select a smaller group when a mutation only affects that group. A new contract also covers nested native-startup holds, repeated release, pause and cancellation; the project routing regressions are reused so unknown quality-profile references cannot silently choose a different provider. All 24 production targets remain in scope.

Do not omit targets, discard survivors, increase thresholds or relabel partial results to make the report appear complete. Narrow diagnostics and individual file timings help assess test-selection changes; they do not establish a complete expanded baseline.

On 2026-10-21, a bounded diagnostic of `delivery-policy.ts` completed in 95.2 seconds: 318 mutants, 277 killed, 33 survived, eight uncovered and no timeouts. Its measured inputs stayed unchanged and the report source matched the recorded digest. The [diagnostic receipt](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/attempts/worker-delivery-policy-diagnostic-2026-10-21.json), [raw report](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/attempts/worker-delivery-policy-diagnostic-2026-10-21.stryker.json) and [log](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/attempts/worker-delivery-policy-diagnostic-2026-10-21.log) preserve that narrower experiment. It preceded the added routing-reference and remote-delivery/retention propagation assertions; those additions then passed in the 170-case unmutated contract run. Those assertions are included in the completed tagged v5 measurement above. The narrower diagnostic, reviewed v4 baseline and incomplete v5 attempts remain unchanged as historical evidence.


The committed configuration uses three workers, a twelve-minute tool cap and bounded individual-mutant execution. Cancellation is forwarded to the owned process; POSIX process-group tests and Windows `taskkill /T /F` cleanup retain that boundary. The advisory lane remains bounded even when its coverage grows.

## Improvements retained independently of a score

The test review found and fixed strict-enum coercion defects in private policy approval, execution routing/snapshots and criterion decisions. Tests now reject arrays and objects where primitive authority fields are required. Candidate-bound exceptions preserve the original observed verification result.

Recovery tests cover unresolved delivery, auxiliary reviewer and legacy execution after restart. An uncertainty-persistence failure retains the live permit and unfinished accounting. Delegated children retain their accounting under the exact parent recovery boundary; parent stop attestation also checks descendant controllers, processes and services. Confirmation records operator-attested cessation, preserves unknown provider outcomes and requires separate explicit continuation. These integration checks complement the pure mutation contracts; they are not claims that fixtures inspected a live subscription provider.

## Inspect and renew evidence

A completed release measurement uploads `mutation.json`, `index.html`, `summary.json`, `summary.md` and `run.log`. An incomplete attempt can lack the raw JSON and HTML report; its summary must keep the score unavailable. The tool removes previous output before starting so an old successful report cannot masquerade as current evidence.

Only after a completed, reviewed run should `scripts/mutation/baseline.json` be deliberately replaced with the exact summary and a corresponding individual survivor review. Equivalent candidates, diagnostics, defensive guards and actual coverage gaps must remain distinct. Every survivor and uncovered mutant remains in the denominator. Timeouts count as detected in Stryker's score but are not assertion failures and must be reported separately.

Historical v1–v4 baselines and their available survivor reviews remain under [`scripts/mutation/baselines`](https://github.com/Luis85/production-line/tree/main/projects/werk/scripts/mutation/baselines). Comparisons require matching scope, Stryker version and measurement configuration. Missing or incompatible evidence must warn instead of manufacturing a score delta. CI never rewrites a baseline automatically.

A narrow development dependency override pins `typed-rest-client`'s transitive `qs` to patched 6.16.1. Keep dependency auditing and remove the override when the upstream dependency accepts a patched version.

## Upstream references

- [StrykerJS TAP runner](https://stryker-mutator.io/docs/stryker-js/tap-runner/)
- [StrykerJS Node guide](https://stryker-mutator.io/docs/stryker-js/guides/nodejs/)
- [StrykerJS configuration](https://stryker-mutator.io/docs/stryker-js/configuration/)
