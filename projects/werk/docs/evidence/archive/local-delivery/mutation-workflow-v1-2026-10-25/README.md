# Workflow mutation refinement, 2026-10-25

The new advisory `worker-workflow-v1` scope measures nine publication, rework,
acceptance, release and journal modules independently of the historical authority
baseline. The first actual run exposed missing assertions; expanded contracts
then killed **307 additional mutants** without changing production sources or
removing any mutant. Both runs completed normally on Node 24.19.0, Linux x64,
StrykerJS 10.0.0.

| Measurement | Killed | Survived | Uncovered | Timeouts | Score | Duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial | 1,168 | 539 | 173 | 0 | 62.13% | 158.063 s |
| After assertion refinement | 1,475 | 345 | 60 | 0 | 78.46% | 151.447 s |

Both denominators contain **1,880 mutants**. Compile errors, runtime errors,
ignored and pending mutants are zero. Assertion-killed and Stryker scores are
identical here because there are no individual timeouts. Exact mutant IDs,
locations and replacements match between runs; every initial kill remains
killed. Of the additional kills, 225 were prior survivors and 82 were uncovered.
Another 31 uncovered mutants became covered survivors, and remain findings.

These are local measurements of a dirty implementation tree based on commit
`db71900f9dae8642e0a7ad65a6abf1769221df69`. The receipt records exact target,
test/support and configuration hashes plus the complete compiled-input digest.
The target-source digest is unchanged. Tests and configuration provenance differ
because assertions were added and two unused exports were removed. This is a
controlled refinement comparison, not a promoted baseline delta. No source,
threshold, timeout or exclusion was changed to raise the score.

## What the findings changed

The added contracts independently exercise each remote PR number, URL, branch,
base and accepted head; current request/candidate/input/policy identity; and
unknown/held or unapproved release views. Rework contracts require the retained
branch head, the same open PR and a compare-and-swap push. They check that lost
push or PR-update acknowledgements are observed before retry and never create a
replacement PR. Journal tests reject another retained PR number and preserve
immutable successful observations and duplicate-publication recovery evidence.

Release receipt tests independently corrupt merged-commit identity, build
operation/manifest identity, configured output names, safe unique artifact names,
byte bounds and checksums. Published receipt tests reject another tag, commit,
URL, timestamp or asset set before completion. Shared feedback tests reject two
distinct unresolved continuations.

Representative previously surviving or uncovered safety mutations now killed:

| Module | Mutant IDs | Guard demonstrated |
| --- | --- | --- |
| `release-runtime.ts` | 13, 15, 19, 80, 86, 88 | Each PR identity component before mutation and after merge observation |
| `remote-delivery-runtime.ts` | 623, 630, 636, 638, 654, 694, 700, 702, 704 | Exact predecessor branch, same open PR, update adapter and outcome |
| `requests/publication.ts` | 1284, 1302, 1314, 1367 | Exact observed branch/PR number and recovery-evidence kind |
| `requests/release.ts` | 1806, 1850, 1930 | Merge/build identity and exact published asset receipt |

IDs refer to the retained raw-report hashes; they are not permanent API IDs.
The TAP adapter selects entire test files: nine file groups ran in the final dry
run. Nested Node contract cases are not nine individual scenarios.

## Remaining findings and limits

All **405 remaining findings** are retained in [final-findings.tsv](final-findings.tsv).
They have not been excluded, relabelled equivalent, or individually approved.
The inventory distinguishes survivors from uncovered mutants and preserves the
exact replacement. Concrete next assertion gaps include:

- `remote-delivery-history.ts` mutant 484: ordering across multiple retained
  historical attempts when the current attempt has no confirmed PR.
- `shared-review-rework.ts` mutants 873/1072 and 902: exact 4,000-character
  boundaries and a mixture of dispatched and unresolved history; identifier/hash
  regex anchors also retain survivors. Mutant 995 retains a malformed-history
  shape gap despite the new distinct unresolved receipt case.
- `requests/publication.ts` mutants 1198/1200/1201 and 1185/1186: closed predecessor
  command admission and exact bounded history limits. Additional result schema,
  cancellation cleanup and reconciliation-metric combinations remain.
- `requests/release.ts` mutants 1442–1460, 1506–1511 and 1755–1795: direct command
  identity, stopped-build recovery and malformed retag evidence. Runtime and
  public-view fences are covered independently; these journal mutations still
  need dedicated boundary assertions.
- `requests/release.ts` mutants 1912–1915 and 1945–1948: mixed published receipt
  types and unconfirmed success payloads. Artifact/hash anchor and upper-bound
  mutations also remain; no valid-input equivalence claim is made.
- Runtime abort checks, some pre-mutation authority booleans, error-classification
  combinations and post-mutation missing-observation results retain findings.
  Diagnostic text replacements also survive where tests assert outcome/identity
  rather than exact wording.

The score is advisory evidence about these nine modules, not a whole-repository
score or live Windows/Claude/GitHub qualification. The completed tagged v5
measurement and reviewed v4 comparison baseline remain unchanged. The two scopes
have different targets and must not be compared as one score.

## Retained artifacts and reproduction

- [receipt.json](receipt.json) retains both exact count tables, per-module results,
  source/test/configuration provenance and SHA-256/byte counts for each original
  summary, raw report and log. The compiled-input manifest is represented by its
  digest and membership count to keep this receipt compact.
- [initial-findings.tsv](initial-findings.tsv) retains every initial surviving or
  uncovered mutant; the final inventory retains every remaining finding.
- Raw source-bearing JSON, HTML, full summary and log stay in the ignored
  `reports/mutation/workflow/` output and the CI `werk-mutation-workflow-report`
  artifact. They are not duplicated in this compact evidence directory.

Run `npm run mutation -- --scope workflow` from `projects/werk` to reproduce the
selected scope. The twelve-minute budget, original denominator rules and
advisory boundary remain intact. PRs and releases run this bounded lane; the
broader authority lane keeps its separate release-only job and report paths.
