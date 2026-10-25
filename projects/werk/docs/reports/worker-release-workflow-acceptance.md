# Worker release workflow acceptance ledger

Date: 2026-10-25. Scope: the standalone worker's primary workflow added to PR #53's domain/process concept. This ledger distinguishes the required acceptance target from evidence obtained during implementation. It is not a release approval.

## Required live acceptance target

Native Windows, Claude Code CLI with a real authenticated account, a real project repository and build assets published to a project-configured GitHub Release. The full journey retains one Feature Request through implementation, verification, human feedback, the same PR, verified merge, exact-source build and publication.

## Evidence boundaries

| Boundary | Required evidence | Qualification state |
| --- | --- | --- |
| Contracts and documentation | Process transitions, DoR/DoD, domain identities, guarded commands and recovery | Defined in the maintained workflow/reference and process notes |
| Managed projects | Real local Git clone/adopt, duplicate/restart/failed-clone handling and unchanged developer checkout | Passed real local Git clone/adopt, replay/recovery and approval-gated intake fixtures; managed/template regression group passed 49 tests |
| Intake and execution | Canonical IDs across interfaces, pinned dispatch, owned worktree, independent checks and bounded repair | Automated provider protocol fixtures prove application behavior only |
| Same-PR rework | Real bare-Git expected-head update/race tests and host protocol fixtures | Passed real bare-Git guarded branch updates and GitHub protocol/restart fixtures; not live GitHub permissions |
| Merge | Current-head acceptance, squash merge identity, conflicts/closed PR, lost acknowledgement/restart | Passed draft readiness, current-head/squash merge, race, replay and restart fixtures; not a live merge claim |
| Build | Exact merged source, successful/failed command, safe artifact inventory and digests | Passed exact-source real Git/process builds, source tampering, replace-ref and artifact-manifest recovery fixtures |
| Publish | Correct target/tag/assets, draft/partial/conflict, unknown outcome and retry | Passed draft/partial release, exact tag/asset digests, unknown outcome and conflict fixtures; not live publication |
| Integrated UI/CLI | Same persisted milestones, next action, stale/unknown blockers and guarded commands | Passed guarded CLI/Markdown/UI fixtures and 22 desktop/mobile browser checks; native and Docker extracted-archive smoke journeys passed |
| Native Windows + live Claude | Packaged runtime on Windows, real provider invocation, interruption/recovery | Pending; a Linux fixture does not satisfy this target |
| Live GitHub release | Same-PR feedback, actual reviewed merge, source-bound build and confirmed published asset digests | Pending; API fixtures do not satisfy this target |

Automated checks must report their actual commands/results in the implementation PR. Do not replace pending native/live rows with inferred success. A green source check or successful release packaging does not establish account permissions, provider availability or published application assets.

## End-to-end acceptance scenario

1. Install the packaged worker on Windows and authenticate Claude Code CLI, Git and GitHub CLI in its account.
2. Register a remote project and approve its committed template/check/build/release policy.
3. Submit a request from the webview and confirm the same stable identity in Markdown/CLI.
4. Have Claude implement a bounded change and exercise a failing independent check followed by repair.
5. Publish the verified candidate; request a change and confirm the next verified candidate updates the same PR and invalidates earlier acceptance.
6. Accept and merge the current candidate; capture the actual merged source identity.
7. Build that exact source, publish the expected assets to GitHub Releases, and verify source/tag, asset names, byte counts and digests.
8. Interrupt remote operations, restart and reconcile without duplicate requests, branch overwrite, duplicate PRs or duplicate releases.

Capture sanitized timestamps, runtime version/source, OS, provider version, request/run/candidate/PR/merge/build/release identities and the exact check outputs needed to substantiate each result. Never include credentials, private prompts or unredacted host logs.

## Backlog reconciliation

The new worker release feature tracks this standalone path. Older P0 items retain their imported line/orchestrator acceptance scope. Reusing their provider, publication or evidence components does not complete leased line publication, mixed-provider live qualification or Factory cost/quality coverage. Follow the [backlog](../backlog/Product%20Backlog.base) and [execution modes](../explanation/modes.md) for those boundaries.

## Documentation and packaging verification

The documentation pass ran these checks in the implementation checkout:

| Check | Observed result |
| --- | --- |
| `node bin/forge.js vault check --strict` with Werk selected | Passed; zero errors and zero warnings; informational orphan attachments remain separate |
| `node bin/forge.js backlog check` with Werk selected | Passed; 53 items, zero errors and zero warnings |
| `node scripts/release/changelog.mjs check` | Passed against the current 0.15.0 release entry and Unreleased changes |
| `node --test tests/operations/release-package.test.mjs tests/operations/release-changelog.test.mjs` | 44 tests passed; zero failed/skipped, including closed local links in the actual shipped documentation allowlist |

These observations verify documentation/backlog consistency and packaging behavior. They do not replace the integrated implementation tests or pending native/live acceptance rows above. Root workspace backlog validation selects `01 - Product Backlog.base` explicitly because the project also keeps its own scoped Base.

## Implementation qualification

Implementation PR: [#54](https://github.com/Luis85/production-line/pull/54), including the reconciled concept documentation from #53. Implementation PBIs 47–53 are complete; live qualification PBI 54 remains open, and the parent release feature remains Active.

Focused checks included 32 release-engine regressions, 49 managed-project/template regressions, 58 shared-intake/feedback regressions, 15 latest-source release-projection/recovery regressions, and 22 composer regressions. These groups overlap existing regression suites and must not be added together as a unique test total. Full unified source and cross-platform CI results are recorded on the implementation PR.

[Browser qualification](../evidence/worker-e2e-release/browser-qualification.json) records 22 desktop/mobile checks with no page errors or overflow. Its screenshots use explicit synthetic project, provider and GitHub data; no live model or host mutation was performed.

![Reviewed candidate and release workflow](../evidence/worker-e2e-release/worker-end-to-end-delivery--merge-reviewed-candidate-1440.png)

![Mobile release publication controls](../evidence/worker-e2e-release/worker-end-to-end-delivery--publish-verified-build-390.png)

The extracted native and Docker archives each completed the existing simulated runtime smoke, persisted evidence and restart checks. The Docker wrapper smoke ran without host Node on its wrapper PATH. These validate packaging and startup compatibility; they do not qualify a Windows Claude account or a worker-managed live release.
