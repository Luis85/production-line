# Publish a verified worker candidate

A local review package is the default delivery result. An approved project can additionally offer two explicit actions: push the exact candidate branch, then create its GitHub pull request. Neither action accepts, merges, or releases the feature. The Feature Request remains the central record.

## Configure the destination

Add a `remoteDelivery` section to the project's existing `.werk/delivery-policy.json`, preserving its other required fields:

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

Commit the policy, then open **Settings → Project delivery** in the worker and approve the exact displayed project policy digest. Repository content cannot grant this permission itself. A different configuration digest needs its own local approval. Revoking approval prevents further mutations, including the next step of an active publication. Restore the intended policy approval before reconciling an unresolved operation.

## Publish from the webview

1. Complete implementation and required checks. Open the Feature Request's current review candidate.
2. Inspect **Remote delivery**: destination repository, base, branch, candidate commit, and approval status.
3. Choose **Push candidate**. Wait for the observation showing the exact commit on the remote branch.
4. Choose **Create pull request**. Wait for the confirmed GitHub number and link. The PR contains the candidate identity, implementation summary, and acceptance evidence; raw private command output is excluded.
5. Perform team review and merge through the repository's normal process. Worker acceptance remains an explicit, separate decision.

The push creates a previously absent worker candidate branch. It never updates an existing branch to another commit, including a branch that appeared after the initial lookup. It does not check out a branch or change the developer's index, staged files, or working files. An already matching remote branch is observed without another push.

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

The adapter uses explicit authenticated [GitHub CLI API requests](https://cli.github.com/manual/gh_api) to the [GitHub pull request REST endpoints](https://docs.github.com/en/rest/pulls/pulls). It does not use the implicit push/fork behavior of `gh pr create`. The create-only Git push uses an empty expected value in [Git's explicit lease syntax](https://git-scm.com/docs/git-push), requiring the destination ref to be absent.

Automated qualification covers real local bare Git publication, unchanged dirty developer files/index, a concurrent branch-creation race, mocked GitHub REST responses, durable SQLite restart recovery, lost acknowledgements, cancellation, and Markdown command identity. Mocked GitHub responses establish adapter and recovery behavior; they do not establish authentication or permissions for your live GitHub account.
