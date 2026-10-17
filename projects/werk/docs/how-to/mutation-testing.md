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

`mutation:contracts` runs 54 focused contract tests without mutation, including
the existing serialized-operation and real SQLite consumption suites. `mutation` runs the complete bounded
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

The release experiment covers seven modules with shared boundary and worker
accounting/protocol responsibilities:

| Module | Contract under test |
| --- | --- |
| `src/shared/serialized-operations.ts` | FIFO execution, independent failures and drain snapshots |
| `src/shared/request-gate.ts` | Bounded, consistent and private-safe completion receipts |
| `src/shared/http/response-body.ts` | Byte limits, reader ownership and cancellation |
| `src/shared/webview/bounded-polling.ts` | Active-view polling, overlap prevention and cancellation |
| `src/worker/application/consumption.ts` | Whole-token shares, UTC windows, reservations, cumulative usage and fail-closed admission |
| `src/worker/infrastructure/journal/consumption.ts` | Real SQLite transactions, restart recovery, durable charges and corrupt-state rejection |
| `src/worker/infrastructure/responses.ts` | Assignment authority, complete task input, context pins and durable acknowledgement identity |

This is not a whole-repository mutation score or proof of end-to-end model
execution. Provider subprocesses, Git worktrees, the wider application services
and Vue rendering remain outside this scope. Ordinary tests and release
qualification cover those paths independently. SQLite tests use isolated temporary
databases; no live provider, application build or existing worker state is needed.

Measured on 17 October 2026 with the committed dependency lockfile, scope
`worker-accounting-protocol-v2` completed in 53.2 seconds:

| Scoped score | Mutants | Killed | Timed out | Survived | Uncovered / errors / ignored |
| --- | ---: | ---: | ---: | ---: | ---: |
| 97.78% | 811 | 777 | 16 | 18 | 0 / 0 / 0 |

The reviewed baseline lives in
[`scripts/mutation/baseline.json`](https://github.com/Luis85/production-line/blob/v0.11.0/projects/werk/scripts/mutation/baseline.json).
It records the measured score, counts, per-file findings, source/test/configuration
hashes, Stryker and Node versions, source commit and checkout state. Stryker's
embedded mutated source must match the recorded source hashes; changing tests or
configuration during measurement makes the run incomplete.

The original four-module experiment is preserved as
[`baselines/shared-boundaries-v1.json`](https://github.com/Luis85/production-line/blob/v0.11.0/projects/werk/scripts/mutation/baselines/shared-boundaries-v1.json):
176 mutants, 94.89%, 25.9 seconds. Its scope differs from the current baseline;
these percentages are not a regression/improvement comparison. No modules or
mutators were removed to improve the reported score.

The expanded first pass exposed missing assertions for invalid provider admission,
initialization failure before polling, terminal-record fencing, durable zero
charges, corrupt accounting totals and optional assignment validation. The
polishing pass added observable assertions for these paths. All 75 SQLite journal
mutants are now detected by assertions. Remaining survivors are retained as
reviewed equivalence candidates, with individual rationale and the exact report
digest in
[`scripts/mutation/survivor-review.json`](https://github.com/Luis85/production-line/blob/v0.11.0/projects/werk/scripts/mutation/survivor-review.json):

- Receipt guards repeat constraints already enforced by strict enum membership or combined nonnegative counts.
- Polling generations are opaque identity values; increasing or decreasing them preserves cancellation behavior.
- Consumption guards repeat validated integer/range constraints; null-aware maxima have equivalent results for nonnegative counters.
- Assignment validator diagnostics are caught and replaced with a fixed public error; repository validation and omitted optional fields repeat existing checks.

These candidates are not excluded or silently counted as killed. The report uses
Stryker's denominator: killed plus timed-out mutants divided by killed, timed-out,
surviving and uncovered mutants. The 16 timeouts come from the bounded shared
asynchronous contracts; they are not described as assertion failures. Compile
errors and ignored mutants are shown separately; runtime errors, missing files,
unknown statuses, source mismatch or interruption make the aggregate score
unavailable.

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
configuration match. Source and test changes remain visible through their hashes
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
3. Review the source/test/configuration digests and full report, then deliberately
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
