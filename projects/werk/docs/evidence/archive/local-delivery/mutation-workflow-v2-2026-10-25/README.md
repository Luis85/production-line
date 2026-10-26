# Plain Git and release workflow mutation measurement, 2026-10-25

The completed advisory **worker-workflow-v2** measurement covers 19 modules and
**2,955 mutants**. It adds local main-checkout merge authority, neutral acceptance,
effective frozen shared policy, completion/retention, baseline and shared-progress
boundaries to the earlier publication/release scope.

| Observation | Result |
| --- | ---: |
| Killed | 2,336 |
| Survived | 529 |
| Uncovered | 90 |
| Timed out | 0 |
| Compile/runtime errors, ignored or pending | 0 |
| Stryker score | 79.05% |
| Assertion-killed score | 79.05% |
| Execution | 269.345 seconds; exit 0; no overall timeout |
| Runtime | Node 24.19.0; Linux x64; StrykerJS 10.0.0 |

Every remaining finding stays in the denominator and the [619-finding inventory](findings.tsv).
There are no timeout-assisted kills. Source, compiled-dependency, selected
suite/support and configuration hashes stayed stable during analysis. The raw
report digest agrees with its original summary and every scored source matches
its recorded hash. This measured an explicitly recorded dirty implementation
tree; it does not claim a clean tagged release.

Run `npm run mutation -- --scope workflow` from `projects/werk`. The final dry run
selected 16 TAP file groups containing 73 Node contracts. File groups are not
individual scenarios. The original three workers, two-second base individual
mutant deadline, twelve-minute overall budget and advisory boundary remain.
PR/release CI uploads `werk-mutation-workflow-report`; publishing does not wait
for this lane. This is selected-boundary evidence, not a whole-system score or
live Windows/Claude qualification.

## Critical guard review

Tests independently construct accepted policies and composed execution gates.
Valid legacy/disabled snapshots ensure a stale digest cannot mask a missing
explicit `localMerge: true` guard. SQLite/status integration tests cover private
approval revocation, changed canonical source, reassignment, admission races and
read-only uncertainty after preparation.

| Module | Reviewed killed mutants | Invariant |
| --- | --- | --- |
| `local-merge-view.ts` | 729/731/733/735/737/739/741/743; 753–756 | Every candidate/request/run identity and explicit policy opt-in |
| `local-merge-view.ts` | 760, 761 | Configured release prevents a competing local merge target |
| `local-merge-runtime.ts` | 664, 669–679 | Mutation authorization and unknown reconciliation outcome |
| `requests/local-merge.ts` | 1952–1966, 2001–2006 | Exact candidate/revision, human acceptance and no unresolved merge |
| `local-merge-baseline.ts` | 570–572, 575, 576, 578, 579, 581–584 | Same-project history, unresolved holds and every retained merge in the next baseline |
| `shared-feature-policy.ts` | 1482–1488 | Frozen execution policy matches workflow plus accepted quality profile |
| `shared-local-merge-projection.ts` | 1531–1542 | Pre-acceptance or held work cannot become integrated completion |

IDs belong only to this raw report. The pending-state contract killed 15/15;
neutral acceptance 95/100; local view 103/123; local runtime 78/94; local journal
233/298. These counts do not imply their full integrations are mutation-tested.

## Remaining findings and priority follow-ups

The 619 findings are not 619 demonstrated production authority bugs. They include
missing combinations, legacy shapes, diagnostics, defensive guards and bounds.
Actual source guards remain intact. None was excluded or automatically declared
equivalent.

1. Expand uncertainty combinations: `local-merge-runtime.ts` survivor 635 needs
   a wrong-branch untouched-before-state case; 665 and line-33 error selectors
   need a domain-conflict observation after mutation, alongside the tested
   generic failure and read-only domain-conflict cases. The implementation
   preserves uncertainty; the mutants identify missing assertions.
2. Expand local journal bounds and schemas: exact maximum path/history/metadata
   limits, prepared-state combinations and malformed results need further
   assertions. All 65 local journal findings, including one uncovered mutant,
   remain visible.
3. Expand presentation combinations: shared local projection survivors 1525/1526
   need done-without-attestation and attested-not-done cases. Existing cases
   change both together. Separate command acceptance still fences mutation.
4. Add partial legacy-shape cases: all five neutral acceptance survivors and
   three baseline survivors remove optional chaining; these merit availability
   assertions for absent context/delivery/state. The shared-policy survivor
   changes only an error string. These differ from the killed authority guards;
   no equivalence/exclusion claim is made.
5. Continue the publication/release review: retained-PR admission, result-schema
   mixtures, retag evidence, exact bounds and historical ordering retain gaps.
   The earlier [v1 review](../mutation-workflow-v1-2026-10-25/README.md) records
   those known limitations; v2 does not silently remove them.

Native Git CAS/HEAD locks, replacement refs, hidden index entries, metadata-only
combined trees and host-driver/filter refusal have separate real Git regressions.
Those infrastructure adapters are outside these 19 mutation targets. Archive and
browser acceptance evidence is separate; this score does not turn fixture
provider execution into a live subscription run.

## Retained evidence

- [receipt.json](receipt.json): exact counts, per-module results, target/test/config
  manifests, compiled-input digest and membership count; original full summary,
  raw report and log byte counts and SHA-256 hashes.
- [findings.tsv](findings.tsv): every survivor/uncovered ID, source location,
  mutator and exact replacement.
- [interrupted-attempt.json](interrupted-attempt.json) and its [log](interrupted-run.log):
  an earlier intentionally stopped run. Downloaded-worker acceptance found
  generated review artifacts in main, requiring a packaging-placement fix. The
  dirty guard stayed intact; the owned process stopped safely. That attempt is
  **incomplete / score unavailable**; partial progress is not a measurement.
- Raw JSON, HTML, full summary and log remain in ignored
  `reports/mutation/workflow/` and the CI artifact, without duplication here.

The [nine-module v1 result](../mutation-workflow-v1-2026-10-25/README.md), tagged
24-module v5 release measurement and reviewed v4 authority baseline remain
unchanged. Different denominators prevent direct baseline score comparisons.
No workflow baseline was promoted; no survivor exclusions, threshold reductions
or timeout increases were introduced.
