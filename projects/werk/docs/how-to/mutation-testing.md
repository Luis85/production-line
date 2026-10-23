# Review mutation testing results

Mutation testing changes production expressions in an isolated sandbox and checks whether tests notice. Werk uses pinned StrykerJS 10.0.0, its TAP adapter and Node 24. Mutation testing remains advisory during releases and does not run in ordinary development checks.

## Current measurement status

The expanded `worker-delivery-authority-v5` experiment covers 24 modules. Its latest full-scope attempt at commit `781b1a1aafc7b833b473fc2aaf3da9a3c02e824e` **did not complete**: it reached the twelve-minute tool limit after 721.6 seconds. There is **no v5 mutation score** and no completed full-scope per-file mutant report. The incomplete attempt does not replace the historical baseline.

The unmutated contract run passed before mutation began. The progress log records partial work, including survivors and timeouts, but those partial counts are not a final denominator or a baseline. The retained [attempt summary](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/attempts/worker-delivery-authority-v5-781b1a1.json) preserves the unavailable score, tool outcome, warnings and source/test/configuration hashes. Its [progress log](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/attempts/worker-delivery-authority-v5-781b1a1.log) preserves the measured work before cancellation. Compiled source, test and configuration snapshots stayed unchanged during the attempt.

The latest completed baseline remains `worker-local-delivery-v4`: 12 modules, 1639 mutants, 96.34% scoped score, 1562 killed, 17 timed out, 58 survived and 2 uncovered. Its [baseline](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/baselines/worker-local-delivery-v4.json) and [survivor review](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/baselines/worker-local-delivery-v4-survivors.json) remain immutable historical evidence. Their smaller scope differs from v5; they do not establish coverage of the expanded implementation and their score cannot be compared with an incomplete run.

## Run the advisory checks

From `projects/werk` in a source checkout:

```sh
npm ci
npm run mutation:contracts
npm run mutation
```

`mutation:contracts` runs observable contract tests without mutation. It reuses serialized-operation, SQLite consumption, Ready Check, criterion-decision, concurrency, execution-policy and check-pack tests, plus focused private approval, behavior, dependency and execution-recovery suites. `mutation` returns failure for tool errors or incomplete evidence. A low score or surviving mutant does not fail qualification.

The usual `npm test`, `npm run check`, builds and pull-request checks do not invoke Stryker. Downloaded runtime archives remain prebuilt and do not contain a requirement to install mutation tools.

`npm run mutation:release` reports incomplete runs and tool errors as warnings. The release workflow runs it as an independent advisory job: publishing does not depend on that job. Setup, install, execution, report-upload and job failures remain visible in workflow summaries and annotations. The job has its own overall deadline.

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

The retained full-scope attempt records 376 compiled TypeScript inputs, including the scored targets. The provenance collector and compiler share discovery rules: worker webviews, `dist`, `public`, `node_modules` and declaration-only files are excluded. Scored source, compiled dependencies, test membership and measurement configuration are hashed before and after the run. Changing any measured input invalidates an otherwise completed score. A missing raw Stryker report cannot establish scored-source equivalence; the retained warnings disclose that limitation.

## Why the broader run exceeded its budget

The pinned TAP adapter selects and measures entire test files. It starts a new Node process for each selected file and uses the file path as the coverage/test identity; nested Node test cases do not become independent selection units. Adding `--test-isolation=none` therefore would not change its selection granularity.

The composed `shared-ready-review.test.mjs` file was repeatedly selected as a whole, rerunning its composed scenarios for each selected mutation. The observed long-running child processes were doing work, rather than merely waiting for timeout. The first two-worker attempt exceeded the twelve-minute cap. A second attempt used three workers on a four-CPU environment with approximately 17.6 GiB RAM and added progress reporting; it also did not complete. Targets, assertions and individual-mutant deadlines were unchanged. Neither attempt produced a score.

The follow-up review splits all 21 composed scenarios into lifecycle, publication, recovery and provider-selection files, sharing the same fixture. Every original test body is preserved. The TAP adapter can now select a smaller group when a mutation only affects that group. A new contract also covers nested native-startup holds, repeated release, pause and cancellation; the project routing regressions are reused so unknown quality-profile references cannot silently choose a different provider. All 24 production targets remain in scope.

Do not omit targets, discard survivors, increase thresholds or relabel partial results to make the report appear complete. Narrow diagnostics and individual file timings help assess test-selection changes; they do not establish a complete expanded baseline.

On 2026-10-21, a bounded diagnostic of `delivery-policy.ts` completed in 95.2 seconds: 318 mutants, 277 killed, 33 survived, eight uncovered and no timeouts. Its measured inputs stayed unchanged and the report source matched the recorded digest. The [diagnostic receipt](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/attempts/worker-delivery-policy-diagnostic-2026-10-21.json), [raw report](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/attempts/worker-delivery-policy-diagnostic-2026-10-21.stryker.json) and [log](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/attempts/worker-delivery-policy-diagnostic-2026-10-21.log) preserve that narrower experiment. It preceded the added routing-reference and remote-delivery/retention propagation assertions; those additions then passed in the 170-case unmutated contract run. They have not been assigned a new mutation score. The completed v4 baseline and incomplete full-scope v5 attempt remain unchanged.


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
