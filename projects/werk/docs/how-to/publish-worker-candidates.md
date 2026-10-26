# Optionally publish a verified candidate to GitHub

The default shared delivery result is a Git branch and PullRequest Markdown handoff; local intake retains its review package locally. Review the delivered increment and explicitly allow its guarded merge into the displayed assigned main checkout without a hosting-service API; existing manual Git integration remains available. A GitHub URL or installed GitHub CLI does not opt the project into hosting-service PR creation.

The local main-checkout merge requires an explicitly enabled and machine-approved `localMerge: true` policy. Its prepared tree may differ from the verified candidate only in retained workflow request, Task, review and operation metadata; other source changes require rework and verification against the new main baseline. Applicable external Git merge drivers or clean/smudge/process filters are unsupported because they can run host commands during preparation or checkout. Unused host filter registrations do not block ordinary repositories. The worker checks current and pinned-tree attributes before preparing or applying the merge, and never pushes main automatically.

A local review package is the default local result. An approved project can additionally publish the exact candidate branch and its GitHub PR through explicit actions or an approved automatic-publication policy. Neither publication action accepts, merges or releases the feature. The Feature Request remains the central record; the optional [release workflow](deliver-worker-release.md) records those downstream actions separately.

## Configure the destination

To explicitly enable GitHub integration, add a `remoteDelivery` section to the project's existing `.werk/delivery-policy.json`, preserving its other required fields:

```json
{
  "remoteDelivery": {
    "remote": "origin",
    "repository": "your-team/your-project",
    "base": "main",
    "push": true,
    "pullRequest": true,
    "draft": true
  }
}
```

The repository must have exactly one push URL for the named remote, and it must identify the configured repository on `github.com`. HTTPS and SSH URLs are supported; credential-bearing URLs, other hosts, multiple push URLs, and mismatched destinations are refused. Git uses the worker account's existing host authentication. Pull request creation uses the installed GitHub CLI and that account's existing GitHub authentication. Authenticate with the official `gh auth login` flow in the account that runs the worker; do not put tokens in the Feature Request or policy.

Commit the policy, then open the selected project's **Policy approval** view in the worker and approve the exact displayed project policy digest. Repository content cannot grant this permission itself. A different configuration digest needs its own local approval. Revoking approval prevents further mutations, including the next step of an active publication. Restore the intended policy approval before reconciling an unresolved operation.

Set optional `remoteDelivery.automatic: true` only when both `push` and `pullRequest` are enabled and the exact committed policy is locally approved. The worker then publishes a verified candidate and its PR after checks pass, including verified rework. Omitting `automatic` within an enabled integration preserves manual GitHub publication and existing policy snapshots. Omitting the entire `remoteDelivery` section keeps Git-only delivery; no GitHub API action or `gh` prerequisite is introduced. Unknown operations, revoked approval and destination conflicts still block new mutations.

## Publish from the webview

1. Complete implementation and required checks. Open the Feature Request's current review candidate.
2. Inspect **Remote delivery**: destination repository, base, branch, candidate commit, and approval status.
3. Choose **Push candidate**. Wait for the observation showing the exact commit on the remote branch.
4. Choose **Create pull request**. Wait for the confirmed GitHub number and link. The PR contains the candidate identity, implementation summary, and acceptance evidence; raw private command output is excluded.
5. Perform team review. Record worker acceptance against the current candidate; merge/build/release use their separately configured [workflow](deliver-worker-release.md) or the team's normal process.

The first push creates a previously absent worker candidate branch using an empty expected-head lease. A branch appearing after the initial lookup is not overwritten. An already matching remote branch is observed without another push; the developer's checkout, index and staged files remain unchanged.

## Retain the same PR through feedback

Later verified candidates of the same Feature Request can update its owned remote branch and existing open PR. The worker freezes the predecessor branch/head and confirmed PR identity from retained delivery history, then uses an expected-head lease. An unrelated branch, concurrent remote update, different repository/base or missing ownership receipt blocks publication.

The local candidate keeps its own immutable branch; its remote destination is the branch recorded in the prior publication receipt. The worker updates the same PR description with current evidence and verifies its number, repository/base, head and publication marker. New candidate content invalidates earlier checks and acceptance. Closed or merged prior PRs block rework publication rather than silently creating a replacement PR.

For local canonical Markdown requests, **Request changes** writes guarded feedback into the same source and the watcher revises/executes that Feature Request. Tasks without a canonical file retain their journal identity. For shared accepted requests, **Request changes** persists candidate-bound feedback, confirms it on the shared branch and then dispatches rework with the original scope, paths, provider and policy. Restart recovery resumes that saved command. A missing or changed shared source blocks dispatch until reconciled. Changed scope requires a successor Feature Request; feedback never grants additional execution authority.


## Publish through the Feature Request

Add this frontmatter to the canonical note, using the exact run, accepted input revision, and complete candidate commit displayed in its worker region or review package:

```yaml
publication:
  command_id: FR-0042-push-1
  action: push_candidate
  run_id: exact-delivery-run-id
  request_revision: 1
  candidate_commit: complete-40-or-64-character-git-commit
```

After the push is confirmed, replace it with a new `command_id` and `action: create_pull_request`, retaining the same candidate identity. The commands use the same guarded journal as webview actions. Publication fields and generated observation text do not create a new semantic input revision. In shared Git intake, commit and push the edited note through the existing shared intake process.

Every command ID identifies one immutable command. Repeated saves or a lost acknowledgement reuse its existing receipt. Use a new command ID for a new explicit action; do not repurpose an old ID.

## Recover an unknown outcome

The worker saves an intent before the network operation. If the process stops or the response is lost, it retains that candidate and marks the outcome unknown. It blocks additional publication and request changes until the saved operation is reconciled. Cancellation cannot erase this uncertainty.

Use **Reconcile this publication**, or add:

```yaml
publication:
  command_id: FR-0042-reconcile-1
  action: reconcile_publication
  operation_id: FR-0042-push-1
  run_id: exact-delivery-run-id
  request_revision: 1
  candidate_commit: complete-40-or-64-character-git-commit
```

Reconciliation only reads the remote. It never pushes or creates a PR. A confirmed observation records the exact branch commit or matching PR. A complete lookup that finds nothing records `not_observed`; only a separate new explicit action can retry. A conflicting branch or unrelated PR is retained as a conflict for inspection. An existing matching open, closed, or merged PR is observed without creating a duplicate. An incomplete or ambiguous response remains unresolved.

The canonical note and gate companion display publication state, operation ID, destination, candidate, and confirmed PR link. These observations remain distinct from local verification and human acceptance. Old receipts retain their original candidate identity.

## Integration and qualification

The adapter uses explicit authenticated [GitHub CLI API requests](https://cli.github.com/manual/gh_api) to the [GitHub pull request REST endpoints](https://docs.github.com/en/rest/pulls/pulls). It does not use the implicit push/fork behavior of `gh pr create`. The initial push uses an empty expected value in [Git's explicit lease syntax](https://git-scm.com/docs/git-push), requiring the destination ref to be absent. Owned rework uses that same explicit lease mechanism with the retained previous head; observation precedes mutation and races remain conflicts.

Automated qualification covers real local bare Git publication, unchanged dirty developer files/index, a concurrent branch-creation race, mocked GitHub REST responses, durable SQLite restart recovery, lost acknowledgements, cancellation, and Markdown command identity. Mocked GitHub responses establish adapter and recovery behavior; they do not establish authentication or permissions for your live GitHub account.
