# Tagged v0.15.0 mutation measurement

The advisory release run completed the full **24-target** `worker-delivery-authority-v5`
scope on commit `9b2db009d23b5e677a3650227ba8f990ca813d27`. This is a completed
measurement, not a whole-system score or an individually reviewed replacement
for the configured v4 comparison baseline.

[Workflow run](https://github.com/Luis85/production-line/actions/runs/40021539389)
· [Original artifact](https://github.com/Luis85/production-line/actions/runs/40021539389/artifacts/12531955702)
· [Current mutation guidance](../../../../how-to/mutation-testing.md)

## Recorded outcome

| Observation | Result |
| --- | --- |
| Score | 91.03% |
| Total mutants | 3,881 |
| Killed | 3,493 |
| Timed out | 40 |
| Survived | 328 |
| Uncovered | 20 |
| Compile/runtime errors, ignored or pending | 0 |
| Execution | 476.795 seconds; exit 0; no overall timeout |
| Runtime | Node 24.21.0; Linux x64; StrykerJS 10.0.0 |
| Source state | Clean tagged commit; package 0.15.0 |

Stryker counts the 40 individual timeouts as detected mutants; they are not
assertion failures. All **348 surviving or uncovered findings** remain in the
report and denominator. Their individual interpretation remains pending; no
finding has been reclassified as equivalent or removed. The smaller v4 scope
is not directly comparable, so this measurement reports no score delta.

## Retained evidence

- [summary.json](summary.json): exact measured counts, per-file results, all
  348 findings and provenance for 24 targets, 379 compiled inputs, 28 test/support
  inputs and seven measurement-configuration inputs.
- [mutation.json](mutation.json): exact raw Stryker report with individual mutant
  outcomes, measured source and test definitions.
- [run.log](run.log): exact tool output from the tagged run.
- [receipt.json](receipt.json): original artifact identity and archive checksum,
  byte counts and SHA-256 hashes of each retained file, and independent hash/count
  verification against the tagged source.

These three artifact files are retained byte-for-byte. Generated HTML and the
redundant Markdown summary are omitted. The raw report hash agrees with the
summary; all reported input hashes match the tagged commit, and every scored
source in the raw report matches its recorded hash. No source, test, threshold
or mutant selection was changed to produce this receipt.

The v0.15.0 archives, release notes and dated review reports preserve their
pre-measurement preparation state. This later receipt records the completed
release result without rewriting those artifacts. `scripts/mutation/baseline.json`
remains the reviewed v4 baseline until an individual survivor review supports a
deliberate update. Future comparisons continue to warn when scope or measurement
configuration differs. Mutation remains advisory and separate from development
checks; this evidence does not qualify live provider execution.
