# Worker request delivery

The default standalone workflow uses Git and Markdown: retain one Feature Request through implementation, independent verification and a PullRequest Markdown handoff. Shared intake publishes the source/review branches and handoff note through ordinary Git. Local intake retains its candidate and review package locally. A person reviews the increment and explicitly allows the worker to merge that exact candidate into the displayed main checkout. The [primary archive tutorial](../tutorials/worker-home-to-main.md) starts from a dedicated worker home and follows that whole journey. This path requires no GitHub API integration or GitHub CLI.

GitHub hosting-service PRs, GitHub-managed merge and GitHub Releases are optional extensions. The plain-Git main-checkout merge does not require them. They require explicit committed `remoteDelivery`/`release` policy and local approval of that exact policy. A GitHub repository URL, installed `gh`, provider login or project registration is not consent to enable them. The selected optional live pilot is native Windows with Claude Code CLI and GitHub Release assets. Git-only fixtures and that pilot prove different boundaries; use the dated [qualification ledger](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reports/worker-release-workflow-acceptance.md) for the actual evidence.

## Identities and authority

| Record | Identity and purpose |
| --- | --- |
| Feature Request | Stable project-scoped request ID, authored outcome, accepted input revision and criteria |
| Delivery run | One retained execution with its immutable baseline, policy, profile and limits |
| Candidate increment | Candidate branch, commit, tree/digest and check-definition identity |
| Human decision | Current request revision, run and candidate commit/digest; never transferable to changed code |
| PullRequest Markdown | Default review handoff: source/review branches, candidate identity and quality evidence |
| Optional hosting-service PR | Explicitly enabled owned request/repository/base identity with current published head |
| Local main-checkout merge receipt | Reviewed candidate, explicit destination checkout/branch/prior head and confirmed resulting local commit |
| Optional GitHub merge receipt | Enabled host PR and actual integrated commit, including squash/rebase result |
| Optional managed build receipt | Exact integrated source, approved build definition and artifact manifest |
| Optional GitHub Release receipt | Repository, tag, URL, visibility and observed expected assets |

One request may retain several candidate increments. Review feedback retains the request identity and produces fresh verification and Markdown handoff evidence. When GitHub PR integration is enabled, it updates the same owned open hosting-service PR. Local canonical requests retain feedback in the same Markdown source. Shared accepted requests persist candidate-bound feedback on the shared branch before dispatching rework, preserving their accepted scope, paths, provider and policy. Changed scope or an incompatible legacy source requires a successor request. The default PullRequest is the Markdown file. A hosting-service PR is a separate optional artifact and requires a confirmed authorized host operation. Model findings cannot grant tools, approve project policy, satisfy human acceptance or publish releases.

## Transition contract

| Stage | Entry | Successful exit | Blocker/recovery |
| --- | --- | --- | --- |
| Intake | Registered project, selected template and author input | One canonical request and accepted readiness handoff | Invalid drafts remain editable; duplicate/conflicting identity blocks admission |
| Pre-Production | Exact accepted input, committed baseline/policy and capacity | Owned branch/worktree, prepared environment and retained dispatch/start prompt | Setup failure retains diagnostics; uncertain prior operations reconcile first |
| Production | Ready isolated workspace and approved provider/tools | Candidate output ready for independent checks | Questions wait for answers; cancellation/failure retains partial work |
| Post-Production | Candidate and frozen check definitions | Passing independent evidence and PullRequest Markdown handoff; shared mode confirms its Git branch/note publication | Bounded repair or visible exhausted-repair hold |
| Review | Current verified candidate and Markdown evidence | Exact-candidate human acceptance followed by explicit permission for the displayed main checkout | Changes invalidate old evidence; rework retains the same request |
| Merge | Reviewed Git candidate, current main checkout/branch/head and explicit user permission | Guarded plain-Git merge receipt for that checkout; optional GitHub merge uses its separate host receipt | Dirty/conflicted/wrong/stale checkout or candidate blocks; unknown results reconcile read-only |
| Build | Default: team's integrated source and build workflow; optional: managed merge receipt and build policy | Default: team retains its build result; optional: worker records an exact-source build and artifact manifest | A Markdown handoff cannot establish a later build; managed build failures preserve the merge |
| Publish | Default: team's publication workflow; optional: retained managed build and explicit release action | Default: project-owned publication; optional: confirmed GitHub Release and matching assets | Core Git delivery does not imply deployment/release; optional partial/draft uploads remain incomplete |

The [Definition of Ready](https://github.com/Luis85/production-line/blob/main/projects/werk/quality/Definition%20of%20Ready.md) and [Definition of Done](https://github.com/Luis85/production-line/blob/main/projects/werk/quality/Definition%20of%20Done.md) separate implementation, review, integration and release evidence. The Obsidian [process landscape](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/processes/Direct%20Feature%20Request%20to%20a%20Worker%20through%20the%20Webview%20Worker%20Intake.md) presents the same stages.

## Managed projects

The portable CLI exposes `projects list`, `projects register`, `projects adopt`, `projects reconcile` and `projects retry`; mutations use a JSON file with the same application command. A worker registers remote repositories or explicitly adopts existing checkouts. Managed remote registration uses `<state-dir>/projects/<project-id>/checkout`; the branch defaults to `main`, and the feature directory defaults to `features`. Registration defaults to shared Git intake; set `intake: "local"` explicitly for local-folder intake. Existing approved external worktree configuration remains explicit. Managed registration binds the existing repository/intake machinery; it does not approve an uncommitted project policy or grant Claude tools automatically.

Commands have a stable `operationId`. Replaying the same identity and payload observes the retained result; changing its payload is rejected. A failed clone retains its own staging identity for inspection/reconciliation. Reconciliation inspects the saved checkout and restores its repository/intake binding when the committed policy permits it; it does not start another clone. Core prerequisites diagnose Git and the selected provider. Optional GitHub integration diagnostics explain its separate prerequisites without copying host credentials into state or request documents. An adopted developer checkout is not relocated or overwritten.

## Git and Markdown handoff

Leave `remoteDelivery` and `release` absent from the delivery policy for the default path. A repository hosted on GitHub still follows this Git-only contract until the operator explicitly enables integration. The worker's checks, local acceptance, shared Git claim and shared branch/note publication keep their existing meaning.

The PullRequest Markdown file identifies the original Feature Request, implementation/source and review branch, exact candidate and quality reports. Review it in Markdown/Obsidian or the worker webview, inspect the Git changes, and explicitly allow the worker's merge into the displayed main checkout. The worker does not infer permission or merge success from the handoff note or candidate acceptance alone. Local mode also leaves branch push to the team's explicitly chosen workflow. Existing review-only policies and manual Git tools retain their established behavior.

## Explicit main-checkout merge

The primary archive journey starts the shipped `worker.mjs` from a dedicated outer worker home, registers a project in the webview and previews its workflow setup. The approved **Commit and push project setup** action creates the missing project workflow files through Git; exact local policy approval is separate. Newly generated setup includes `localMerge: true` and leaves GitHub integration absent.

`localMerge` is an optional strict boolean in the committed delivery policy. When true, current-candidate review acceptance leaves delivery in progress until the local main-checkout merge is confirmed. Older policies without this requirement preserve their previous review-completion semantics and do not gain merge authority from a Markdown command. Enable, commit and locally approve `localMerge: true` before new work is admitted to use the capability; retained accepted snapshots do not silently expand. The merge also requires an explicit current-candidate user decision naming the destination; policy approval alone does not merge anything.

The destination is the assigned repository's local checkout path and configured branch, or its observed checked-out branch when no branch was assigned. It is displayed with its current head. A worker-owned clone beneath the home may be that main checkout; a merge receipt does not imply that another developer clone or remote branch was updated.

The worker requires a clean target checkout/index and rejects untracked/conflicting work, another branch, stale main head or stale candidate. To preserve the verified code identity, the prepared merge may differ from the verified candidate tree only in frozen allowed workflow request/review/Task metadata files. Source or configuration divergence outside that allowance requires rework and fresh verification against current main, even when Git could merge it without a text conflict. It retains intent/prepared integration identity before changing refs and worktree files, preserves unrelated newer main work, and refuses conflicts instead of force-resetting or discarding files. An uncertain acknowledgement is reconciled against the exact saved checkout and Git state before another mutation. A confirmed local merge changes that checkout/ref; it does not push the resulting main branch or mutate another clone. Interruption between checkout/index update and ref commit can remain unknown with files preserved. Read-only reconciliation observes that state; it cannot repair/discard files or authorize an automatic reset.

The authenticated CLI exposes `request local-merge --id REQUEST_ID` for inspection, `request merge-local` for the explicit merge, and `request reconcile-local-merge` for read-only reconciliation. Mutations carry the request ID, current numeric `--if-match`, a unique immutable `--key`, and a JSON `--file`. The merge payload identifies `deliveryRunId`, `inputRevision`, `candidateCommit`, `candidateDigest`, `mainCheckout`, `mainBranch` and `mainHead`; reconciliation also identifies `localMergeOperationId`. Use the same worker home/state and read the current view before issuing a command.

If the accepted policy also configures the separate GitHub release path, that path takes precedence and competing local-main merge is disabled; use the selected view's reason to inspect the active workflow.

After a confirmed local merge, the worker does not push main automatically. The operator publishes/synchronizes the integrated main commit before later shared requests can use it as their accepted baseline. Requests prepared against an older baseline must be refreshed/reprepared or replaced to include that increment; otherwise new admission stays held.

Confirmed local-merge request history is retained in this version and cannot be deleted while it provides this safety evidence. A future independent durable project receipt ledger can permit history cleanup without losing the admission guard. Canonical Markdown has the same [local_merge command contract](feature-requests.md#main-checkout-merge-from-markdown).

These are plain-Git local actions. The optional hosting-service command `request merge` remains a separate GitHub integration action. Neither a Markdown handoff nor local merge creates a GitHub PR or publishes a release.

## Optional GitHub integration and release policy

GitHub candidate publication first requires an explicit `remoteDelivery` section; `release` additionally enables its managed merge/build/release extension. Both belong to the committed `.werk/delivery-policy.json`. It is included in the complete policy digest that the local operator approves. It identifies:

- The exact GitHub `repository` and target `base`, matching the remote candidate destination.
- `mergeMethod`: `merge`, `squash` or `rebase`.
- `build.executable`, `build.args`, `build.timeoutMs` and configured relative `build.artifacts`.
- The permitted `tagPrefix` and `prerelease` choice.

The build executable is launched directly with an argument list, not interpreted from request Markdown as shell text. Artifact paths remain inside an owned build workspace; symlinks, traversal and changed bytes cannot become trusted release assets. A checksum manifest links the published content back to the retained source/build.

Within an explicitly enabled GitHub integration, optional `remoteDelivery.automatic: true` runs candidate publication after successful verification under the approved policy; omitting that field keeps manual GitHub actions. Omitting the entire `remoteDelivery` section keeps Git-only delivery and performs no host PR operation. Initial pushes are create-only, while owned rework requires the retained expected previous head and same open PR identity. Publication and release permissions remain distinct from the provider login and request acceptance. Exact committed policy approval is rechecked at operation boundaries; revocation prevents further mutations. See [project delivery policy](delivery-policy.md), [candidate publication](../how-to/publish-worker-candidates.md) and [security](security.md).

### Policy limits and generated assets

All release fields are explicit; the optional section has no implicit destination or build defaults. The repository uses GitHub `owner/name`, and its base must be a valid branch. `tagPrefix` is a simple prefix of at most 32 characters and may be empty; requested tags are simple names of at most 100 characters and must start with that prefix.

The build executable is at most 4,096 characters. It accepts at most 64 arguments of at most 4,096 characters each, and a timeout from 1,000 to 3,600,000 milliseconds. Select 1–32 exact repository-relative artifact paths. Asset basenames must be unique case-insensitively, use simple letters/digits/dot/underscore/hyphen names, and be at most 200 characters. Globs are not artifact declarations.

Artifacts are limited to 64 MiB per file and 256 MiB for the package. The worker generates `SHA256SUMS` and `werk-release-manifest.json`; project artifact declarations cannot reuse those reserved names. The retained build uses a detached owned worktree and a separate immutable asset package, preserving the developer checkout.

## Guarded release commands

After the integration is committed and approved, use the authenticated request command interface documented by the installed CLI's `request schema`. Each release command identifies `requestId`, `expectedRevision`, a unique `operationId`, `deliveryRunId`, `inputRevision`, `candidateCommit` and `candidateDigest`.

| Action | Additional identity | Result |
| --- | --- | --- |
| `merge_candidate` | Current owned PR from the retained publication receipt | Matching observed merge commit |
| `build_release` | Confirmed merge receipt | Exact-source build and artifact manifest |
| `publish_release` | `releaseTag` | Published GitHub Release and observed assets |
| `reconcile_release` | `releaseOperationId` | Read-only observation of a saved unresolved operation |
| `confirm_release_stopped` | `releaseOperationId` and an explicit inspection `note` | Operator attestation that an unknown build was inspected/stopped; permits a separate retry |

An explicit managed merge action can mark its confirmed owned draft PR ready after current-candidate human acceptance, then recheck its head and authorization before expected-head merge. Merely opening a draft PR does not enable merge. Reconciliation remains read-only.

A duplicate command returns its receipt. A stale request revision, different candidate, unapproved policy, active operation or unresolved outcome prevents a new mutation. A command acknowledgement alone is not proof that GitHub completed the operation.

## Recovery and projections

Persist intent before remote mutation. Unknown outcomes remain unknown until the worker can observe the exact destination. Reconciliation is read-only: it never merges, rebuilds, uploads or creates a release. Absence established by a complete lookup permits a separate new explicit attempt; incomplete observations remain held.

Rework retains earlier candidates, evidence and publication receipts. An expected-head update prevents a raced or unrelated remote branch from being overwritten. A failed post-merge build retains the merge receipt. A failed upload retains the successful build. Existing published releases or differing tags/assets cause a conflict rather than destructive replacement.

A publication retry keeps its original tag after a mutation may have occurred, including a retained draft or partial upload. A different tag is permitted only when every earlier attempt for another tag retained positive preflight evidence of a conflicting Git object and an absent or foreign release, before any publication was attempted. This lets an initial version collision be corrected without overwriting the existing tag or abandoning a worker-owned draft. Read-only reconciliation cannot manufacture that permission for an earlier uncertain attempt.

When a build process has completed but a declared output is missing, its operation fails with the missing-artifact finding. This is distinct from an interrupted process with an unknown outcome; no stopped-process attestation is needed for that known build failure.

The worker's request detail, Kanban progress, Markdown status and CLI present persisted milestones and their next allowed action. Local verification, human acceptance, host review, merge, build and release are separate facts. For release-enabled requests, local acceptance can finish the implementation review phase while the delivery lifecycle remains in progress until `release.published` confirms the exact source/assets. New web-generated `localMerge: true` policies retain delivery in progress until the exact local-main merge is confirmed. Existing policies without local-merge or release requirements retain their established review-completion semantics. Factory/orchestrator assignments retain their documented execution modes; this standalone workflow does not qualify the separate leased line publisher.
