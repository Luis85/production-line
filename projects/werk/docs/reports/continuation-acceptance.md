# Werk continuation acceptance criteria

This pass improves the working product without claiming live agent delivery. The imported concept remains reference material. Mock stays the default; real provider and Git publication gates stay explicit.

## Planned verification

1. Resolve ready requirements from a full Git commit through a read-only CLI: immutable manifest, bounded documented dependency subset, useful errors for missing, ambiguous, unsafe or unsupported context. This is a foundation for P0-01; server-owned project bindings and task assignment integration remain separate.
2. Add bounded keyset pagination for task, worker and event APIs and CLI consumption while preserving existing no-query clients. Reject invalid cursors and avoid duplicates under concurrent changes.
3. Retain bounded acknowledged worker history without removing pending evidence or losing replay safety. Exercise restart and failed acknowledgment behavior.
4. Resolve concrete HTTP boundary and UI recovery defects with regressions and real browser checks where applicable.
5. Independently review changes, run TypeScript, independent builds, all tests, dependency audit and Forge document/backlog/workflow gates. Record any verification limits.
6. Record Forge usage and verified friction first. Then delegate focused upstream improvements in an independent branch, run upstream checks and open a pull request.

Each lane records detailed evidence in its review report. Only implemented and validated acceptance is marked done in the backlog.
