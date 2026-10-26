# Dashboard mutation evidence, 2026-10-26

The new dashboard has an independent advisory mutation scope,
`worker-workflow-dashboard-v1`, covering three pure modules. This evidence does
not replace or change the historical 24-module authority or 19-module workflow
measurements or baselines. Run `npm run mutation -- --scope dashboard` from
`projects/werk`.

| Outcome | Initial | Test-only follow-up | Corrected-source final |
| --- | ---: | ---: | ---: |
| Total/valid mutants | 982 | 982 | 998 |
| Assertion-killed | 526 | 671 | 677 |
| Survived | 414 | 296 | 305 |
| Uncovered | 40 | 13 | 14 |
| Timed out | 2 | 2 | 2 |
| Compile/runtime errors, ignored or pending | 0 | 0 | 0 |
| Strict assertion score | 53.56% | 68.33% | 67.84% |
| Stryker score, including timeouts | 53.77% | 68.53% | 68.04% |
| Selected Node contracts | 17 | 25 | 26 |
| Duration | 58.000 s | 61.245 s | 64.254 s |

All three runs completed with exit 0, without overall timeout or source/test/config
drift. These local runs record an uncommitted working tree explicitly. Runtime:
Node 24.19.0, Linux x64, StrykerJS 10.0.0. The final result remains below the
advisory 70% threshold; it is not presented as a passing mutation quality target.
No baseline was created or promoted, survivor excluded, threshold lowered, or
mutant deadline/overall budget increased.

## What changed and what the numbers mean

The initial and test-only follow-up use identical target sources, compiled
sources, configuration and mutant universe. Meaningful boundary contracts add
**147 new assertion kills** (132 previous survivors and 15 uncovered), while
**two previous kills become survivors**, for a **net gain of 145**. Twelve other
uncovered mutants become covered survivors. The two lost kills concerned legacy
run lookup: changing one fixture to an explicit run ID removed its no-ID shape.
Both legitimate shapes were restored before final measurement. Every transition,
including the regressions, is retained rather than hidden by a net score.

Independent review then found a real historical-snapshot defect: a previous run's
typed steps could suppress the production transition of a newer legacy run. The
implementation now correlates execution-start evidence with its own run, by
explicit ID or dated input revision. A new regression exercises both shapes.
**The corrected-source final has a different source hash and 998-mutant universe.**
Its score is reported independently; the 145-kill delta is not a claim about
that changed production version. Scope file membership and measurement settings
remain unchanged.

The selected contracts exercise observable report behavior:

- UTC Monday/year/offset boundaries and half-open completion windows; default
  104-bucket bounds, independent invalid endpoints and partial-week means.
- Confirmed integration rather than acceptance, stale done state or a future
  receipt; release merge/build/publish stages and their observed ages; valid
  40/64-character literal commit identities, pre-run refusal and zero durations.
- Older submissions completed within the window, a separate submission cohort,
  canonical/intake deduplication, profile filters and available option lists.
- Sorted timing percentiles, unknown/zero/nonfinite samples, incomplete cycles,
  retained legacy execution history and implementation rather than orchestration.
- Known blockers, observed-clear stages and unavailable blocker coverage;
  durable holds clipped to the historical snapshot; measured zero failure/rework
  observations distinguished from unavailable histories.
- Customer/current/unrealized business value remains explicitly unmeasured;
  operational activity never establishes customer outcomes or productivity.

## Remaining findings and reviewed limits

The final inventory retains **305 survivors, 14 uncovered mutants and two
individual timeouts**: 321 entries in total. They are test gaps and generated
variants, not 321 demonstrated production defects. No finding is automatically
labelled equivalent.

| Final target | Killed | Survived | Uncovered | Timeout |
| --- | ---: | ---: | ---: | ---: |
| Retained evidence/snapshots | 462 | 245 | 11 | 0 |
| Report aggregation | 180 | 55 | 3 | 1 |
| UTC observation window | 35 | 5 | 0 | 1 |

Priorities for further contracts include mixed legacy histories and correlated
run selection, malformed/partial historical shapes, each phase's stage/age
transitions, oldest-of-multiple ages, earliest-of-multiple integration receipts,
and independent rework/failure event boundaries and deduplication. Some optional
guards are masked by downstream checks; some strings describe visible labels or
coverage explanations. These distinctions need individual review, not blanket
exclusions or exact copies of implementation branches.

The final generated timeout variants are 843 (`at -= workflowWeekMs`, the bucket
loop moving backwards) and 728 (`7 / 86400000`, a near-zero week length). They
are retained as timeouts, not assertion kills. IDs are local to this final
universe. Stryker counts their detection in its score; the strict score above
excludes them. The three-minute overall budget, existing two-second base
per-mutant deadline, factor two, three workers and per-test coverage are unchanged
throughout the experiment.

## Retained proof

- `initial-receipt.json`, `test-only-followup-receipt.json`, `final-receipt.json`:
  exact counts, source/test/configuration manifests, universe and raw-report
  hashes, runtime, dirty-tree identity, durations and warnings for each attempt.
- `initial-findings.tsv`, `test-only-followup-findings.tsv`, `final-findings.tsv`:
  every non-killed mutant in each corresponding attempt, including timeouts.
- `test-only-transitions.tsv`: every changed status in the comparable 982-mutant
  test-only experiment, including the two lost kills.
- `comparison.json`: machine-readable comparable-run checks, status transitions
  and explicit corrected-source universe/source differences.

Full source-bearing JSON, HTML, log and summary remain in the ignored
`reports/mutation/dashboard/` output. Compact retained evidence preserves the
complete residual inventories without committing instrumented application code.
Dashboard evidence does not establish native-platform/provider qualification or
replace archive/browser acceptance.
