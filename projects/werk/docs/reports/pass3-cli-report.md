# Werk pass 3: Forge CLI findings

Recorded 2026-10-12, before dispatching Forge implementation agents. Final product validation and upstream PR results are recorded below.

## Tools used and useful capabilities

Published Forge 0.1.0 remains installed. Project selection, revision-bearing reads, reviewed apply dry-runs, guarded writes, backlog and workflow inspection, vault validation, and browser capture support this pass. Native Node/Git tools remain necessary for builds, runtime tests, immutable Git fixtures, and upstream publishing. Parallel agents keep the shared Werk selection fixed.

## F3-01: bounded batch reads

There is no read-many command; read accepts one path. Two isolated one-shot reads each took roughly 200 ms locally; this is an observation, not a benchmark. Reading several related source files requires repeated CLI startups and separate result assembly.

Proposed additive command: read-many <paths...> [--project <id>], with at most 32 explicit paths and 8 MiB aggregate raw file bytes. Preserve input order and existing read document, encoding, byte-count, and revision semantics. Reject normalized duplicate paths. Fail the whole bundle on a missing, unsafe, malformed, or oversized input, preserving the error code and adding a zero-based input index and safe path. Each revision describes an individual read; the bundle is not an atomic filesystem snapshot. Base64 and JSON can exceed the raw-byte budget. Existing reads allocate entire files, so a post-read cap must not be advertised as a hard memory bound; a true allocation bound needs bounded repository I/O.

## F3-02: explicit project targeting

An isolated fixture read identical shared.txt content in project alpha, selected beta, then successfully dry-ran an alpha-intended revision-guarded plan in beta. The hash correctly guards bytes; it does not identify a project. apply --project alpha currently fails with UNKNOWN_OPTION. This is a scope limitation, not revision corruption.

Add invocation-local --project to read and apply, using the existing projectOption routing metadata. Explicit targeting must leave saved selection unchanged, fail without fallback for unknown or unsafe targets, and retain dry-run, stale-revision, protected-path, and plan-validation safeguards. Include concurrent alpha/beta routing and project-local plan-path tests. Batch reads should support the same option.

## Dispatch and review boundaries

Implement in two dedicated lanes after this report: batch reads with bounded output and encoding parity; explicit read/apply project targeting with isolation regressions. Serialize their small shared command-registration edits. Use a fresh main-based branch, independently review source, rebuild distribution, regenerate showcase where skills change, and run the full upstream gate before opening a PR.

Upstream main was verified as 976b6d2e08625e20d15b7065faf21e407ad8612c. Earlier PRs #23 and #24 remain open and unmerged. This pass must neither include them nor claim their fixes are installed.

## Product limits retained

Pinned context and worker provenance are being integrated this pass. Live provider execution, remote repository identity, fenced publishing, and verified PR evidence remain separate readiness requirements. Pagination must be consumed by UI and MCP, not merely offered by the server. Raw audit evidence is retained in work/pass3/audit/report.json and reproductions.json in the execution workspace.

## Implementation and additional workflow findings

After saving this report, dedicated agents implemented both proposals in an independent main-based Forge worktree. read-many preserves exact canonical path semantics, rejects duplicates, and returns ordered default-read data plus aggregate raw bytes. Single read and apply use the existing project-routing metadata; no selection mutation or new routing core was introduced. Independent review found no blocker. Source, portable workflows, a reference evaluation, documentation, German help, skills, distribution and showcase are included. Final full-gate and PR details follow below.

The user then requested concern-based source/test organization. Forge guarded move plans preserved Markdown references during all 42 test moves and 16 source moves. Language-level imports and prose command paths still required explicit rebasing and full checks. A future relocation manifest identifying language import candidates, affected build/test entrypoints and unresolved references would help; it must not claim automatic semantic refactoring. A literal-safe plan builder and an isolated check runner would also reduce scratch orchestration. None of these additional suggestions is falsely represented as implemented by this PR.

The read-many cap is deliberately an accepted-content/output contract, not a bounded-read memory primitive. A future FileRepository bounded-read port would be needed to constrain allocations before loading large files. Source and tests for this PR already match Forge's concern folders; no cosmetic extra moves were needed there.

## Integration feedback for Forge maintainers

The first full upstream gate exposed five integration failures: existing help/catalog expectations needed the additive command/option, the new German command text belonged in the command catalog rather than the option-description table, and a new evaluation would exceed the documented 35-task budget. The fixes preserve those gates: exact help/discovery assertions were updated, localization was registered correctly, and the existing read-property evaluation was extended without dropping its original checks or increasing the budget. The development skill now explicitly respects that budget. A future fast catalog check combining command discovery, localization parity and evaluation-budget validation would shorten feedback before the full portable suite.

## Final validation and pull request

Opened [Forge PR #25: Read file bundles and target projects without changing selection](https://github.com/Luis85/agent-cli/pull/25). It targets main and contains exact tested commit `75d6db11c1d08bebefa966f919bab30176381264`, based on `976b6d2e08625e20d15b7065faf21e407ad8612c`. The upstream worktree is clean and the pushed head was verified. The PR is open, non-draft and unmerged. GitHub CI was running/queued when checked once after creation; no remote pass is claimed.

Final upstream `npm run check` exited 0: structure, lint, analysis, TypeScript, rebuilt distribution, **2,762 passing tests and two skipped**, then showcase validation with no differences. Focused portable scope, batch-read, metadata/localization and evaluation regressions also passed. The existing read-property reference evaluation passed while the full evaluation catalog stayed at 35 tasks. Independent reviewers found no blockers and exercised the new batch-read command on Forge's own files without changing selection.

Werk separately passed its final typecheck, all three builds and **272 tests with no skips**; dependency audit found zero vulnerabilities. Its 16 source-module moves and all 42 test-file moves preserve CLI/build contracts and recursive discovery. Strict vault, backlog and workflow gates passed. Reports, acceptance, architecture/test documentation and backlog evidence are updated locally. The installed Forge release remains 0.1.0; this PR and prior PRs #23/#24 are proposed upstream improvements, not an installed release update.
