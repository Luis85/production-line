# Dashboard mutation contract follow-up, 2026-10-26

Four additional observable contract groups raise the strict assertion score from
**67.84% to 72.04%** on the same three target sources and **998-mutant universe**.
All previous 677 assertion kills remain killed, and **42 previous survivors are
now killed**. One uncovered mutant becomes a covered survivor. No production
target, measurement configuration, deadline, threshold or baseline changed.

| Outcome | Previous corrected-source run | Follow-up |
| --- | ---: | ---: |
| Assertion-killed | 677 | 719 |
| Survived | 305 | 264 |
| Uncovered | 14 | 13 |
| Timed out | 2 | 2 |
| Compile/runtime errors, ignored or pending | 0 | 0 |
| Total/valid mutants | 998 | 998 |
| Strict assertion score | 67.84% | 72.04% |
| Stryker score, including timeouts | 68.04% | 72.24% |
| Selected Node contracts | 26 | 30 |

The final run completed in 67.502 seconds, exit 0, without overall timeout or
source/test/configuration drift. Runtime: Node 24.19.0, Linux x64, StrykerJS 10.0.0.
The receipt records the local dirty tree explicitly. Mutation remains advisory
and no dashboard baseline is installed or promoted. This clears the existing
70% advisory threshold; it does not establish complete test coverage.

## Observable behavior added

- Every delivery phase enters its documented stage: assessing/planning/preparing,
  implementing/repairing and verifying/packaging. Stage age begins at the observed
  phase start, with exactly one active stage per request.
- Oldest stage age differs from its median, while missing anchors remain unknown
  and an empty stage has no oldest age.
- A canonical request with multiple retained integration receipts counts once at
  its earliest confirmed integration, preserving its first week and lead/cycle
  anchors rather than moving throughput to the latest attempt.
- Failure/rework events obey the half-open observation window. Recorded execution
  and review failures count independently, duplicate journal events count once,
  and a failed step recorded in both journal and run evidence is counted once.

The tests assert report outcomes and mathematical boundary values rather than
matching incidental labels or copying implementation branches.

## Comparison limits and remaining findings

Target file membership, all three target hashes, mutant identities and all
measurement configuration hashes match the previous corrected-source run. The
three-minute overall cap, existing two-second base individual deadline, factor
two, three workers and per-test coverage remain unchanged. Between runs, an
independent HTTP route telemetry fix changed `src/shared/http/observability.ts`,
outside the three targets and their selected pure-contract imports. The complete
compiled-source digest therefore differs; the receipt exposes that difference.
Each individual run still passed its full compiled-source drift check.

There are **264 survivors, 13 uncovered mutants and two timeouts** remaining. All
279 entries are retained in `findings.tsv`; none was excluded or automatically
classified as equivalent. Priorities remain historical/partial input shapes,
correlated run and stage-transition combinations, optional guards masked by
other checks and some visible labels or coverage explanations. The inventory
is not a claim that each generated survivor is a production defect.

| Target | Killed | Survived | Uncovered | Timeout |
| --- | ---: | ---: | ---: | ---: |
| Retained evidence/snapshots | 500 | 208 | 10 | 0 |
| Report aggregation | 184 | 51 | 3 | 1 |
| UTC observation window | 35 | 5 | 0 | 1 |

Timeouts remain the synthetic backward bucket increment (843) and near-zero week
length (728). They count in Stryker's score, never in the strict assertion score.
The previous three attempts, including the lower initial result and its explicit
test-only coverage tradeoff, remain unchanged in
[the original evidence](../mutation-dashboard-v1-2026-10-26/README.md).

## Reproduction and retained evidence

Run `npm run mutation -- --scope dashboard` from `projects/werk`. The authored
release workflow configures a separate advisory dashboard job for pull requests,
tags and manual runs. It retains `reports/mutation/dashboard/` in the
`werk-mutation-dashboard-report` artifact even for incomplete measurements. CI
execution is separate evidence; this receipt describes the completed local run.

- `receipt.json`: exact final counts and runtime, source/test/configuration
  manifests, raw-report hash, universe hash, comparison and all status totals.
- `transitions.tsv`: all 321 previous non-killed findings and their new statuses.
- `newly-killed.tsv`: the 42 new assertion kills.
- `findings.tsv`: all 279 remaining non-killed findings, including timeouts.

Raw JSON, HTML, log and summary remain in the ignored
`reports/mutation/dashboard/` output. Historical authority/workflow measurements
and baselines are unchanged. Dashboard evidence is separate from browser, native
platform and live-provider qualification.
