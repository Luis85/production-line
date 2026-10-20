# Review mutation testing results

Mutation testing changes production expressions in an isolated sandbox and checks
whether tests notice. Werk uses pinned StrykerJS 10.0.0 with its TAP runner and the
existing Node 24 `node:test` toolchain. It is an advisory release experiment, not a
new development gate. Downloaded runtime archives remain prebuilt; operating a
worker does not require installing the mutation tools.

## Run it when useful

From `projects/werk` in a source checkout, install the committed lockfile and run:

```sh
npm ci
npm run mutation:contracts
npm run mutation
```

`mutation:contracts` runs 104 focused contract tests without mutation, including
the existing serialized-operation and real SQLite consumption suites, structural
Ready Check admission, reviewer result contracts and the durable Feature Request
lifecycle, committed delivery quality profiles and accepted dependency ordering.
`mutation` runs the complete bounded
experiment and returns a failure for tool errors or incomplete evidence. A low
score or surviving mutant does not fail either release or local qualification.
The usual `npm test`, `npm run check`, builds, pull request checks and interactive
development do not invoke Stryker.

`npm run mutation:release` also reports tool failures as warnings and returns
success. The tag/manual release workflow runs it in an independent advisory job;
publishing does not depend on this job. Setup, install, execution, report upload
and job failures are surfaced in the workflow summary and annotations. A run has
two Stryker workers, an eight-minute tool budget and a shorter individual-mutant
timeout; the release job has a separate overall time limit. Cancelling a local
run forwards cancellation to the tool. POSIX process-group fixtures verify
cleanup when a descendant ignores termination or its leader exits early; Windows
uses `taskkill /T /F` for cancellation and timeout cleanup.

## Understand the scoped baseline

The `worker-local-delivery-v4` release experiment covers twelve modules with shared
boundary, worker accounting, Feature Request readiness and local delivery policy
responsibilities:

| Module | Contract under test |
| --- | --- |
| `src/shared/serialized-operations.ts` | FIFO execution, independent failures and drain snapshots |
| `src/shared/request-gate.ts` | Bounded, consistent and private-safe completion receipts |
| `src/shared/http/response-body.ts` | Byte limits, reader ownership and cancellation |
| `src/shared/webview/bounded-polling.ts` | Active-view polling, overlap prevention and cancellation |
| `src/worker/application/consumption.ts` | Whole-token shares, UTC windows, reservations, cumulative usage and fail-closed admission |
| `src/worker/application/delivery-policy.ts` | Bounded committed profiles, immutable baselines, protected verification inputs and mandatory readiness rules |
| `src/worker/application/delivery-dependencies.ts` | Cycle and identity validation, human acceptance and exact-baseline code incorporation |
| `src/worker/infrastructure/journal/consumption.ts` | Real SQLite transactions, restart recovery, durable charges and corrupt-state rejection |
| `src/worker/infrastructure/responses.ts` | Assignment authority, complete task input, context pins and durable acknowledgement identity |
| `src/worker/application/ready-review-protocol.ts` | Strict reviewer findings, blocking questions, bounded responses and untrusted review context |
| `src/worker/application/shared-ready-review.ts` | Claim-before-payment ordering, explicit re-review, revision fencing, capacity, restart holds and deterministic DoR handoff |
| `src/worker/infrastructure/features/review-eligibility.ts` | Structural admission before semantic DoR, safe repository scope, author metadata and source bounds |

This is not a whole-repository mutation score or proof of end-to-end model
execution. Provider subprocesses, Git worktrees, the wider application services
and Vue rendering remain outside this scope. Ordinary tests and release
qualification cover those paths independently. SQLite tests use isolated temporary
databases; no live provider, application build or existing worker state is needed.

The current baseline, measured on 2026-10-20 with the committed dependency lockfile,
scope `worker-local-delivery-v4`, completed in 160.9 seconds:

| Scoped score | Mutants | Killed | Timed out | Survived | Uncovered / errors / ignored |
| --- | ---: | ---: | ---: | ---: | ---: |
| 96.34% | 1639 | 1562 | 17 | 58 | 2 / 0 / 0 |

The reviewed baseline lives in
[`scripts/mutation/baseline.json`](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/baseline.json).
It preserves the completed summary exactly: score, counts, per-file findings,
source/test/configuration hashes, Stryker and Node versions, source commit and
checkout state. This measurement records an uncommitted implementation checkout;
its content hashes identify the tested state. The twelve scored source files are
recorded separately from all 313 TypeScript inputs compiled by the isolated
harness, including unmutated dependencies. The compiler and provenance collector
share the same discovery rules; the worker webview, `dist`, `public`,
`node_modules` and `.d.ts` files are excluded from compilation.

Stryker's embedded source must match the scored-source hashes. The measurement
also rediscovers compiled source and test membership afterward: changing,
adding or deleting a compiled dependency or matched test makes the analysis
incomplete. Measurement/configuration scripts have their own before-and-after
hashes. This prevents a successful report from claiming reproducibility while
its supporting source or tests changed.

Historical experiments remain available:

- [`baselines/shared-boundaries-v1.json`](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/baselines/shared-boundaries-v1.json): four modules, 176 mutants, 94.89%, 25.9 seconds.
- [`baselines/worker-accounting-protocol-v2.json`](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/baselines/worker-accounting-protocol-v2.json): seven modules, 811 mutants, 97.78%, 53.2 seconds, with its [survivor review](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/baselines/worker-accounting-protocol-v2-survivors.json).
- [`baselines/worker-ready-review-v3.json`](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/baselines/worker-ready-review-v3.json): ten modules, 1334 mutants, 97.60%, 137.2 seconds, with its [survivor review](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/baselines/worker-ready-review-v3-survivors.json).

Their scopes and measurement configurations differ from v4. These percentages
are historical evidence, not regression or improvement comparisons. No module,
mutator or surviving result was excluded to raise the current score.

The Ready Check pass exposed assertions masked by unrelated rejection paths.
Existing tests exercised nonboolean blocking flags only in results that also
claimed to pass, and tested chat-mode rejection with file paths still present.
Dedicated assertions now check each boundary independently. Reviewing the
result contract also found and fixed a coercion bug: an array containing
`question` could bypass the blocking-question rule. Finding kinds now require
strict string membership, covered by ordinary runner tests and mutation contracts.
Lifecycle tests also cover advancing time without idle publication churn, pushed changes during
queued and running reviews, profile incompatibility, questions arriving before
result projection, missing restart evidence, capacity holds, lost acknowledgments
and cancellation of a pass publication. These are local port and persistence
contracts; they do not claim that a real provider implemented a feature.

The local delivery pass strengthened tests whose rejection paths had masked the
contract under test. Invalid custom profile names now retain both mandatory
profiles, the 16-profile boundary uses distinct identities, and a duplicate
profile is added without removing a required one. Tests assert public error codes,
the complete default verification-protection list and a reserved readiness-rule
collision among multiple mandatory rules. A valid folder approval exercises the
Ready Check path branch. These observable contracts reduce false confidence from
an unrelated exception satisfying a broad rejection assertion.

Every remaining survivor and uncovered mutant is retained with an individual
classification and rationale, bound to the exact report, source and test digests,
in [`scripts/mutation/survivor-review.json`](https://github.com/Luis85/production-line/blob/main/projects/werk/scripts/mutation/survivor-review.json).
The classifications distinguish equivalent candidates from diagnostic wording
changes, defensive guards and explicit coverage gaps. The focused suite still lacks
assertions for Unicode case-fold distinctions, a one-character approved filename in
Ready Check, and rejection of a persisted baseline supplied as a one-item JSON
array. These remain surviving mutants, with no equivalence claim. The two uncovered branches are a duplicate-path
diagnostic already rejected by an earlier validator and a fallback for non-Error
throws. Their remaining coverage limits are explicit, without fabricated tests
or a claim of complete coverage.

The raw report uses Stryker's denominator: killed plus timed-out mutants divided
by killed, timed-out, surviving and uncovered mutants. Its 17 timeouts count
as detected but are not described as assertion failures. Compile errors and
ignored mutants are shown separately; runtime errors, missing files, duplicate
or unknown mutant identities/statuses, source mismatch or interruption make the
aggregate score unavailable.

## Inspect release evidence

Download the `werk-mutation-report` artifact from the release workflow. Open
`index.html` for the interactive source-level report. The same directory contains:

- `mutation.json`: the complete Stryker report, including mutation locations and replacements.
- `summary.json`: limited scope, per-file counts, surviving/uncovered mutants, run outcome and provenance.
- `summary.md`: the human-readable workflow summary.
- `run.log`: tool diagnostics, including incomplete runs.

The job emits warnings for surviving or uncovered mutants, lower scores,
incomplete analysis and tool errors. A previous HTML or JSON report is removed
before starting, so a failed run cannot reuse an old successful result. Baseline
deltas are calculated only when the declared scope, Stryker version and mutation
configuration match. Scored source, compiled dependencies and test changes remain visible through their hashes
and can legitimately improve the score. Missing or incompatible baselines warn
without manufacturing a comparison.

A workflow job that is forcibly cancelled before reporting may have no artifact;
its workflow status is then the evidence that qualification did not complete.
Release availability is independent of that advisory outcome.

## Expand or renew the baseline

1. Add a small cohesive source module to `scripts/mutation/scope.mjs` and provide
   focused observable-contract tests. Keep application builds and live provider
   calls out of individual-mutant execution.
2. Run `mutation:contracts`, then `mutation`. Inspect survivors and timeouts in
   the HTML report; distinguish missing assertions from equivalent behavior.
3. Review the scored-source, compiled-source, test and configuration digests and
   full report, then deliberately
   replace `scripts/mutation/baseline.json` with the reviewed `summary.json`.
   Baselines are never rewritten automatically by CI. Document a scope/version
   change rather than comparing incompatible numbers.
4. Keep the run within its resource budget and retain the nonblocking release
   boundary. Do not add Stryker to `check`, `test` or `publish.needs`.

A narrow dependency override pins `typed-rest-client`'s transitive `qs` to patched
6.16.1 because the client bundled by Stryker pins vulnerable 6.15.1. The override
applies to the development tool only; keep `npm audit --audit-level=low` green and
remove the override when the upstream dependency accepts a patched version.

## Upstream references

- [StrykerJS TAP runner](https://stryker-mutator.io/docs/stryker-js/tap-runner/): Node test output, per-file coverage and runner limitations.
- [StrykerJS Node guide](https://stryker-mutator.io/docs/stryker-js/guides/nodejs/): compile instrumented TypeScript once before running mutations.
- [StrykerJS configuration](https://stryker-mutator.io/docs/stryker-js/configuration/): scope, concurrency, reports and advisory thresholds.
