# Worker intake to a published release

The primary standalone workflow retains one Feature Request from authoring through a published GitHub Release. Native Windows with Claude Code CLI and GitHub Release assets is the live acceptance target. An automated provider fixture establishes only the boundaries it exercises; use the dated [qualification ledger](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reports/worker-release-workflow-acceptance.md) for the actual evidence.

## Identities and authority

| Record | Identity and purpose |
| --- | --- |
| Feature Request | Stable project-scoped request ID, authored outcome, accepted input revision and criteria |
| Delivery run | One retained execution with its immutable baseline, policy, profile and limits |
| Candidate increment | Candidate branch, commit, tree/digest and check-definition identity |
| Human decision | Current request revision, run and candidate commit/digest; never transferable to changed code |
| Hosting-service PR | Stable owned request/repository/base identity with current published head |
| Merge receipt | PR and actual integrated commit, including the host's squash/rebase result |
| Build receipt | Exact integrated source, approved build definition and artifact manifest |
| Release receipt | Repository, tag, URL, visibility and observed expected assets |

One request may retain several candidate increments. Review feedback updates its owned PR after fresh verification. Local canonical requests retain feedback in the same Markdown source. Shared accepted requests persist candidate-bound feedback on the shared branch before dispatching rework, preserving their accepted scope, paths, provider and policy. Changed scope or an incompatible legacy source requires a successor request. A Markdown PullRequest note is a review handoff; a remote PR requires a separate confirmed host operation. Model findings cannot grant tools, approve project policy, satisfy human acceptance or publish releases.

## Transition contract

| Stage | Entry | Successful exit | Blocker/recovery |
| --- | --- | --- | --- |
| Intake | Registered project, selected template and author input | One canonical request and accepted readiness handoff | Invalid drafts remain editable; duplicate/conflicting identity blocks admission |
| Pre-Production | Exact accepted input, committed baseline/policy and capacity | Owned branch/worktree, prepared environment and retained dispatch/start prompt | Setup failure retains diagnostics; uncertain prior operations reconcile first |
| Production | Ready isolated workspace and approved provider/tools | Candidate output ready for independent checks | Questions wait for answers; cancellation/failure retains partial work |
| Post-Production | Candidate and frozen check definitions | Passing independent evidence, review package and authorized initial PR publication | Bounded repair or visible exhausted-repair hold |
| Review | Current verified published candidate and evidence | Exact-candidate human acceptance where required | Changes invalidate old evidence; rework uses the same owned PR |
| Merge | Current accepted head, destination policy and host merge rules | Confirmed actual merge commit | Conflict/closed/unmerged/stale head blocks; unknown acknowledgement reconciles |
| Build | Confirmed merge receipt and approved build definition | Successful exact-source build and artifact manifest | Failed/missing/unsafe artifacts block publication while preserving merge |
| Publish | Retained verified build, configured tag/destination and explicit action | Confirmed published release and matching expected assets | Partial/draft/unavailable results remain incomplete; published content is not overwritten |

The [Definition of Ready](https://github.com/Luis85/production-line/blob/main/projects/werk/quality/Definition%20of%20Ready.md) and [Definition of Done](https://github.com/Luis85/production-line/blob/main/projects/werk/quality/Definition%20of%20Done.md) separate implementation, review, integration and release evidence. The Obsidian [process landscape](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/processes/Direct%20Feature%20Request%20to%20a%20Worker%20through%20the%20Webview%20Worker%20Intake.md) presents the same stages.

## Managed projects

The portable CLI exposes `projects list`, `projects register`, `projects adopt`, `projects reconcile` and `projects retry`; mutations use a JSON file with the same application command. A worker registers remote repositories or explicitly adopts existing checkouts. Managed remote registration uses `<state-dir>/projects/<project-id>/checkout`; the branch defaults to `main`, and the feature directory defaults to `features`. Registration defaults to shared Git intake; set `intake: "local"` explicitly for local-folder intake. Existing approved external worktree configuration remains explicit. Managed registration binds the existing repository/intake machinery; it does not approve an uncommitted project policy or grant Claude tools automatically.

Commands have a stable `operationId`. Replaying the same identity and payload observes the retained result; changing its payload is rejected. A failed clone retains its own staging identity for inspection/reconciliation. Reconciliation inspects the saved checkout and restores its repository/intake binding when the committed policy permits it; it does not start another clone. Git, Claude and GitHub prerequisites are diagnosed without copying host credentials into state or request documents. An adopted developer checkout is not relocated or overwritten.

## Release policy

`release` is an optional section of the committed `.werk/delivery-policy.json`. It is included in the complete policy digest that the local operator approves. It identifies:

- The exact GitHub `repository` and target `base`, matching the remote candidate destination.
- `mergeMethod`: `merge`, `squash` or `rebase`.
- `build.executable`, `build.args`, `build.timeoutMs` and configured relative `build.artifacts`.
- The permitted `tagPrefix` and `prerelease` choice.

The build executable is launched directly with an argument list, not interpreted from request Markdown as shell text. Artifact paths remain inside an owned build workspace; symlinks, traversal and changed bytes cannot become trusted release assets. A checksum manifest links the published content back to the retained source/build.

Optional `remoteDelivery.automatic: true` runs candidate publication after successful verification under the approved policy; its absence keeps manual publication. Initial pushes are create-only, while owned rework requires the retained expected previous head and same open PR identity. Publication and release permissions remain distinct from the provider login and request acceptance. Exact committed policy approval is rechecked at operation boundaries; revocation prevents further mutations. See [project delivery policy](delivery-policy.md), [candidate publication](../how-to/publish-worker-candidates.md) and [security](security.md).

### Policy limits and generated assets

All release fields are explicit; the optional section has no implicit destination or build defaults. The repository uses GitHub `owner/name`, and its base must be a valid branch. `tagPrefix` is a simple prefix of at most 32 characters and may be empty; requested tags are simple names of at most 100 characters and must start with that prefix.

The build executable is at most 4,096 characters. It accepts at most 64 arguments of at most 4,096 characters each, and a timeout from 1,000 to 3,600,000 milliseconds. Select 1–32 exact repository-relative artifact paths. Asset basenames must be unique case-insensitively, use simple letters/digits/dot/underscore/hyphen names, and be at most 200 characters. Globs are not artifact declarations.

Artifacts are limited to 64 MiB per file and 256 MiB for the package. The worker generates `SHA256SUMS` and `werk-release-manifest.json`; project artifact declarations cannot reuse those reserved names. The retained build uses a detached owned worktree and a separate immutable asset package, preserving the developer checkout.

## Guarded release commands

Use the authenticated request command interface documented by the installed CLI's `request schema`. Each release command identifies `requestId`, `expectedRevision`, a unique `operationId`, `deliveryRunId`, `inputRevision`, `candidateCommit` and `candidateDigest`.

| Action | Additional identity | Result |
| --- | --- | --- |
| `merge_candidate` | Current owned PR from the retained publication receipt | Matching observed merge commit |
| `build_release` | Confirmed merge receipt | Exact-source build and artifact manifest |
| `publish_release` | `releaseTag` | Published GitHub Release and observed assets |
| `reconcile_release` | `releaseOperationId` | Read-only observation of a saved unresolved operation |
| `confirm_release_stopped` | `releaseOperationId` and an explicit inspection `note` | Operator attestation that an unknown build was inspected/stopped; permits a separate retry |

A duplicate command returns its receipt. A stale request revision, different candidate, unapproved policy, active operation or unresolved outcome prevents a new mutation. A command acknowledgement alone is not proof that GitHub completed the operation.

## Recovery and projections

Persist intent before remote mutation. Unknown outcomes remain unknown until the worker can observe the exact destination. Reconciliation is read-only: it never merges, rebuilds, uploads or creates a release. Absence established by a complete lookup permits a separate new explicit attempt; incomplete observations remain held.

Rework retains earlier candidates, evidence and publication receipts. An expected-head update prevents a raced or unrelated remote branch from being overwritten. A failed post-merge build retains the merge receipt. A failed upload retains the successful build. Existing published releases or differing tags/assets cause a conflict rather than destructive replacement.

A publication retry keeps its original tag after a mutation may have occurred, including a retained draft or partial upload. A different tag is permitted only when every earlier attempt for another tag retained positive preflight evidence of a conflicting Git object and an absent or foreign release, before any publication was attempted. This lets an initial version collision be corrected without overwriting the existing tag or abandoning a worker-owned draft. Read-only reconciliation cannot manufacture that permission for an earlier uncertain attempt.

When a build process has completed but a declared output is missing, its operation fails with the missing-artifact finding. This is distinct from an interrupted process with an unknown outcome; no stopped-process attestation is needed for that known build failure.

The worker's request detail, Kanban progress, Markdown status and CLI present persisted milestones and their next allowed action. Local verification, human acceptance, host review, merge, build and release are separate facts. For release-enabled requests, local acceptance can finish the implementation review phase while the delivery lifecycle remains in progress until `release.published` confirms the exact source/assets. Existing local-only requests retain their established completion semantics when no release policy is configured. Factory/orchestrator assignments retain their documented execution modes; this standalone workflow does not qualify the separate leased line publisher.
