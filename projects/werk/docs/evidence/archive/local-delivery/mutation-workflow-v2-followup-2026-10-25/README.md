# Workflow mutation follow-up, 2026-10-25

The same **19 production modules and 2,955 mutants** were measured again after
30 additional Node contract tests. Production sources and measurement settings
are unchanged. The assertion-killed score increased **79.05% → 83.72%**, with
**138 additional kills**. Every one of the original 2,336 kills remains killed.

| Outcome | Initial | Follow-up |
| --- | ---: | ---: |
| Killed | 2,336 | 2,474 |
| Survived | 529 | 401 |
| Uncovered | 90 | 80 |
| Timed out | 0 | 0 |
| Compile/runtime errors, ignored or pending | 0 | 0 |
| Total/valid mutants | 2,955 | 2,955 |
| Stryker and assertion-killed score | 79.05% | 83.72% |

Of the additional kills, **132 were survivors and six were uncovered**. Four
other uncovered mutants became covered survivors and remain findings. There are
**481 remaining findings**; none was excluded or automatically reclassified as
equivalent. This is a completed measurement, exit 0 in 429.367 seconds, with no
source/test/configuration drift or overall timeout. Runtime: Node 24.19.0,
Linux x64, StrykerJS 10.0.0. This local run records its dirty tree explicitly.

## What the tests now establish

The selected contracts increased from **73 to 103**, across 16 to 19 TAP file
groups. They verify observable outcomes and immutable data rather than copying
implementation branches or forcing unreachable objects with getters/proxies.

- Recovery from an untouched head on another branch or a dirty checkout remains
  unknown and performs no preparation or checkout write. A real domain conflict
  after checkout or during final authorization remains unknown; a later read-only
  observation confirms the same merge without another write. Conflict-shaped
  transport errors do not leak private details or become trusted failures.
- Local journal contracts cover full Git identities, exact branch/path/history/
  metadata limits, unsettled-operation lookup, immutable preparations, malformed
  results and success receipts. Valid boundary values remain valid.
- Shared progress distinguishes done-without-attestation from attested-not-done,
  respects each hold across operation statuses, and requires a retained receipt
  rather than a status string for completed integration. Ordinary partial legacy
  histories remain readable without inventing acceptance or ancestry.
- Publication/release contracts cover retained closed/merged PR admission,
  exact candidate command identity, schema and success-receipt mixtures, retag
  evidence, safe retry history and newest eligible historical PR ordering.

| Target | Initial kills | Follow-up kills |
| --- | ---: | ---: |
| Neutral acceptance | 95 | 97 |
| Local merge view | 103 | 104 |
| Local merge runtime | 78 | 91 |
| Local merge baseline | 15 | 18 |
| Local merge journal | 233 | 289 |
| Remote publication history | 30 | 31 |
| Shared local merge projection | 62 | 67 |
| Publication journal | 236 | 260 |
| Release journal | 345 | 378 |

All targeted runtime cases 606, 635, 665 and the reviewed line-33 classification
variants are now killed. Shared projection 1516/1525/1526/1544/1545 and baseline
573/574/580 are killed. Publication/release/history probes 2320, 2391, 2437,
2728, 2875, 3032, 3065 and 1206 are killed. These IDs belong to this report's
unchanged mutant universe, not permanent API identifiers.

## Remaining findings

The inventory still includes untested input combinations, legacy/defensive
conditions, schema limits and diagnostics; it is not a list of 481 demonstrated
production authority defects. Actual guards remain intact.

- Local runtime has three remaining error-message literals (641/644/662), with
  all generated conditional/boolean mutants killed in that module. This is evidence
  about the generated mutants, not proof of complete runtime correctness.
- Local journal has nine survivors. OID/type 1882 and checkout/type 2028 need
  single-element JSON-array refusal cases; null/number controls do not expose
  coercion. Allowed-status literals 2081/2120 need positive preparation/result
  updates directly from a saved unknown operation, since reconciliation first
  changes its state to pending. Timestamp 2192 needs a deterministic chronology
  assertion. The independent empty-component rule masks branch length 1914/1915;
  1968/1978 affect refusal wording/field labels. No exclusion is taken for any.
- Three neutral-acceptance optional-chain removals (90/92/98) remain behind
  existing candidate/shape guards. They were not forced with artificial accessors
  or labelled equivalent. Baseline and shared local projection have no remaining
  generated mutants, without implying all integration behavior is proven.
- Other publication, release, quality-policy and feedback findings remain in
  [findings.tsv](findings.tsv), including all 80 uncovered mutants. Further work
  should prioritize meaningful lifecycle/schema combinations before diagnostic
  wording and retain known boundaries where independent checks mask a mutation.

## Reproducible comparison and evidence

Run `npm run mutation -- --scope workflow` from `projects/werk`. The scope ID,
19 targets, all target hashes, all measurement configuration hashes, Stryker
version, three workers, two-second base individual deadline and twelve-minute
budget are unchanged. Mutation remains advisory. No baseline was promoted,
mutation threshold reduced, mutant deadline or overall measurement budget increased, or survivor excluded.

The original [receipt](../mutation-workflow-v2-2026-10-25/receipt.json),
[619-finding inventory](../mutation-workflow-v2-2026-10-25/findings.tsv) and
[review](../mutation-workflow-v2-2026-10-25/README.md) remain unchanged. The initial
79.05% result was independently reproduced on the clean CI PR merge in
[run 40216658830](https://github.com/Luis85/production-line/actions/runs/40216658830),
[artifact 12608241761](https://github.com/Luis85/production-line/actions/runs/40216658830/artifacts/12608241761).
Its archive and raw-report hashes were independently verified, as were its source
and configuration manifests against the original local measurement.

- [receipt.json](receipt.json): exact final counts/provenance, source/configuration
  and mutant-universe comparison, every status-transition count, CI baseline
  identity and hashes, plus original final summary/report/log hashes and sizes.
- [transitions.tsv](transitions.tsv): every one of the original 619 findings,
  including its new status and unchanged location/mutator/replacement.
- [newly-killed.tsv](newly-killed.tsv): all 138 newly killed findings.
- [findings.tsv](findings.tsv): all 481 remaining survivors/uncovered findings.

Full raw JSON, HTML, summary and log stay in ignored
`reports/mutation/workflow/` and the `werk-mutation-workflow-report` CI artifact.
This compact evidence preserves the complete residual inventory without copying
large source-bearing reports. The configured baseline remains unchanged, so the
runner still warns that no baseline is installed; this documented comparison
uses the verified earlier measurement rather than silently promoting one.

The older nine-module v1 and 24-module authority results have different
denominators and are not used for this score delta. Mutation evidence remains
separate from native Windows/live provider qualification and archive acceptance.
