# Werk pass 4: Forge CLI findings

Recorded 2026-10-12 before dedicated upstream implementation dispatch. Product and upstream results will be appended after validation.

## Workflow and verified upstream state

Published Forge 0.1.0 remains installed and its update check reports no newer release. Revision-bearing reads, mutation previews, guarded apply plans, project scope checks, browser capture, vault validation, backlog and workflow checks support this work. Native Git, Node, npm and test runners remain necessary for process integration, package validation and publishing a pull request. Parallel agents keep the shared selection fixed at Werk.

Upstream main is `976b6d2e08625e20d15b7065faf21e407ad8612c`. PRs [#23](https://github.com/Luis85/agent-cli/pull/23), [#24](https://github.com/Luis85/agent-cli/pull/24) and [#25](https://github.com/Luis85/agent-cli/pull/25) are open, unmerged and separate. Neither candidate below duplicates those changes. Use an independent main-based branch; do not replace the installed release with an unmerged fork.

## F4-01: earlier source contract feedback

Pass 3 passed structure, lint, analysis and typechecking before its portable suite found five integration failures after roughly six minutes: command discovery, localization, evaluation budget and portable help expectations. The existing check:fast does not run those source contracts.

Add `npm run check:contracts` to run seven existing source suites covering metadata, command discovery, localization, documentation consistency and evaluation harness limits. Call it from check:fast before build, preserving all exact assertions, the 35-task evaluation budget and the complete portable gate. An isolated archive of current main without bin passed all 92 selected tests in 6.81 seconds; deleting one German command entry in that scratch fixture caused an immediate failure. These are observations, not a performance guarantee. Dependencies must be installed, but the source gate must not require built distribution or browser installation. Portable artifact and exact rendered-help checks still belong in the full gate.

## F4-02: inspect revisions without document decoding

There is no stat command. Reading a directory fails, so obtaining its revision currently requires a pretend move dry-run. Reading malformed YAML fails without a revision, although a conflicting write preview exposes it as a workaround. Binary reads return the complete base64 payload even when only size and revision are needed.

Add read-only `stat <path> [--project <id>]` using the existing repository stat port. Return compact file path/kind/revision/bytes, or folder path/kind/revision/fileCount/folderCount. Match the exact revision guards already used by moves and deletes. Count regular descendant files and folders as defined by the existing repository result; do not return unbounded descendant arrays. Malformed structured content and invalid UTF-8 must be inspectable without parsing. Preserve missing-path, symlink, traversal and protected-path safeguards. Explicit project targeting must leave selection unchanged and fail without fallback for unsafe or unknown targets.

The result is bounded metadata; implementation still reads and hashes content and recursively visits directories. Do not advertise constant-time operation, a hard allocation bound, parse validation or project identity. Acceptance includes file parity, folder revision changes, no vault mutation events, project isolation and portable inspect-to-guarded-repair/move workflows. Update schemas, help, German catalog, docs and skills; extend an existing evaluation within the current budget.

## Dispatch and deferred tools

After saving this report, dispatch separate agents for the source contract gate and metadata command. Keep new command/output modules and tests in Forge's existing concern folders. Parent integration owns shared navigation, rebuilt distribution, showcase and full checks. Raw audit evidence is retained in work/pass4/audit/report.json and reproductions.json in this execution workspace.

Language-aware relocation assistance would have helped the earlier source/test reorganization: guarded moves preserve vault links, but language imports, source fixtures and build entrypoints require explicit updates. A correct implementation needs language-aware resolution rather than a broad textual replacement. A bounded file-read port and literal-safe plan assembly remain useful future improvements. They are outside this focused PR and are not claimed as delivered.

## Implemented changes and additional findings

Dedicated agents implemented both proposals on the independent main-based branch. The fast gate runs seven existing source suites and a separate regression proves a failed contract prevents subsequent build/test/showcase stages. A no-bin source snapshot passed 92 tests. Four independent scratch faults—missing German command, stale discovery, undocumented option and a 36th evaluation—each correctly failed. Existing full checks and the 35-task limit remain intact.

Stat source tests passed 17 cases; three portable workflows passed guarded malformed-document repair, exact folder move/delete guards and explicit project isolation. The existing list-folder reference evaluation passed with its original answer checks retained. Independent review caught missing project-routing errors in the published schema, which were added with portable assertions. Parent used the rebuilt command on Forge's own source folder and guide while preserving project selection. The released Werk installation remains unchanged.

Implementation feedback: the fast pipeline caught temporary TypeScript errors before build, while source contract probes verified the new early feedback. Native package tests, Git fixtures and npm remain the appropriate tools for semantic verification. Guarded multi-file changes still require scratch plan assembly and stable source snapshots for isolated tests. A versioned literal-safe plan builder and revision-associated validation snapshots would reduce that orchestration.

Browser screenshot capture worked through Forge. Authenticated interaction and deliberate loss of a committed HTTP response required direct Playwright scripting. A documented companion workflow or constrained browser request-fault fixtures would help; neither is implemented in this PR. One missing apply-plan version produced a precise schema error before mutation, and one wrong working-directory invocation failed before mutation. Root-relative command examples and versioned plan examples would reduce those authoring mistakes.

Werk's final integrated check passed 306 tests with no skips, plus TypeScript and all three builds. Dependency audit found zero vulnerabilities; strict vault, backlog and workflow checks passed. Full upstream gate and PR details follow after completion.

## Final upstream validation and pull request

Opened [Forge PR #26: Inspect file revisions and check source contracts before builds](https://github.com/Luis85/agent-cli/pull/26). Exact tested and pushed head: `32ee152d42f162368185eba6f405005fb0ba293a`, based on main `976b6d2e08625e20d15b7065faf21e407ad8612c`. The 32-file change includes source, tests, documentation, skills, distribution and regenerated showcase assets. The upstream worktree is clean. PRs #23–25 remain separate and unmerged.

Final `npm run check` exited 0: structure, lint, analysis, TypeScript, seven source contract suites, distribution rebuild, **2,757 passing tests and two skipped**, then showcase validation with no differences. Independent source review and 17 stat source tests passed; three portable stat workflows and the extended list-folder reference evaluation passed. The evaluation catalog remains at 35 tasks. The generated Playwright license had only a line-ending difference, verified and restored before staging; no license-content change is included.

The PR is open, non-draft and mergeable. Its five GitHub workflows were queued when checked once after creation; no remote CI pass is claimed. No merge, reviewer request or comment was submitted. Werk remains on installed Forge 0.1.0 with its local product changes and fixed project selection; upstream proposals are not installed release features.
