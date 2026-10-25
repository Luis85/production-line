# Deliver a worker request through GitHub Releases

Use this guide to run the standalone worker workflow from a request to published build assets. It targets a native Windows worker using Claude Code CLI and a project-configured GitHub Release destination. Read the [workflow reference](../reference/worker-release-workflow.md) for identities, gates and recovery; consult the [qualification ledger](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reports/worker-release-workflow-acceptance.md) before treating fixture results as native/live qualification.

## Prepare the worker and project

1. Install a prebuilt worker with [project worker setup](project-worker.md) and use Node 24.x. Keep private worker state separate from shared Git content.
2. Configure Claude Code CLI in the account that runs the worker and check it in **Settings → Providers & accounts**. Review approved file/command/MCP access independently of provider authentication.
3. Register the remote project through managed-project settings, or explicitly adopt the intended existing checkout. Choose its shared branch and request directory. A registration failure keeps actionable diagnostics; it does not authorize changing an unrelated checkout.
4. Authenticate Git and GitHub CLI in that same worker account. The worker uses their official host authentication. Never copy credentials into a Feature Request, prompt, policy, URL or release asset.
5. Commit the project's template, readiness/completion rules, approved build/check configuration and `.werk/delivery-policy.json`. Approve the exact displayed policy digest in **Settings → Project delivery**.

A managed clone lives in `<state-dir>/projects/<project-id>/checkout`. A registered project is not automatically ready for execution: missing templates, unapproved policy, unavailable tools and unresolved readiness still require action.

## Manage projects through the CLI

The installed worker CLI exposes the same project operations:

```sh
node bin/apps/worker/cli.mjs projects list
node bin/apps/worker/cli.mjs projects register --file register-project.json
```

For a remote clone, `register-project.json` contains the selected project and a unique command identity:

```json
{
  "operationId": "register-example-1",
  "id": "example",
  "name": "Example project",
  "repository": "https://github.com/your-team/your-project.git",
  "branch": "main",
  "featuresDirectory": "features"
}
```

Use `projects adopt --file adopt-project.json` with `operationId`, `id`, the existing absolute `path`, and optional branch/feature-directory settings. For a saved incomplete operation, inspect `projects list`, then use `projects reconcile --file command.json`; use `projects retry --file command.json` only for a known incomplete clone, with a new operation ID. Schema discovery on the installed runtime gives the exact accepted fields. Registration and adoption never auto-approve project policy.

## Configure the release destination

Preserve the policy's existing required fields and candidate `remoteDelivery` settings. Add a `release` section for the same repository/base. Configure `mergeMethod`, the exact build executable and argument list, timeout, expected artifact paths, tag prefix and prerelease behavior. Use the installed policy validator/schema and [policy reference](../reference/delivery-policy.md) for accepted bounds.

For example, the additional policy section can run Node directly and package one exact output file:

```json
{
  "release": {
    "repository": "your-team/your-project",
    "base": "main",
    "mergeMethod": "squash",
    "tagPrefix": "v",
    "prerelease": false,
    "build": {
      "executable": "node",
      "args": ["scripts/build-release.mjs"],
      "timeoutMs": 300000,
      "artifacts": ["release/application.zip"]
    }
  }
}
```

This is a section to merge into the existing valid delivery policy, not a replacement policy file. Artifact declarations are exact paths, not globs; the worker adds `SHA256SUMS` and `werk-release-manifest.json` automatically. Commit the build definition with the policy. Run dependency preparation only through the project's approved development setup; a request cannot grant arbitrary commands.

Changing any policy field changes its digest. Commit and approve the resulting policy before accepting new work. Already accepted requests keep their policy snapshots; changing a file does not silently authorize new release behavior for those runs.

## Submit and follow the request

Open **Taskboard → New request**, choose the registered project and template, enter the outcome, criteria and approved scope, and keep the default Low priority or choose Medium/High. Prepare the draft, inspect readiness findings, and submit through the configured intake mode.

For shared Git, the ready request must be committed and pushed to the watched branch and claimed remotely before execution. A local save alone does not start shared work. Keep the original request identity when answering questions through Markdown or the webview.

The worker prepares an isolated worktree, records its dispatch/start prompt, invokes Claude with the accepted limits, and runs independent candidate checks. Inspect failed/unknown checks and any bounded repair attempts. A model completion message is not a passing test result.

## Review and merge

After passing verification, inspect the review package: accepted scope, current changes, criteria, check evidence, limitations and candidate identity. Use the authorized candidate push and PR creation actions, or configure approved `remoteDelivery.automatic: true` to perform them after passing checks. The recorded GitHub link confirms remote creation; a Markdown review note alone does not.

Request changes when needed. Local canonical requests retain feedback in the same Markdown source. Shared accepted requests keep their pinned scope; follow the published Task continuation or create a successor request when the visible hold requires it. Rework must pass fresh checks and update the same owned PR. If its remote head changed outside the worker's expected head, inspect the conflict before continuing; the worker does not overwrite that change.

Record required human acceptance for the exact current candidate. Then use the merge action. Repository branch protection and hosting-service reviews still apply. Wait for a confirmed merge receipt containing the actual integrated commit. A closed PR or local acceptance does not replace it.

## Build and publish

Run the build action after merge is confirmed. The worker builds the exact recorded merged commit in an owned workspace and retains its artifact inventory and checksums. A post-merge build failure is a release blocker with the successful merge preserved.

Choose a release tag permitted by the project's configured prefix and run the explicit publish action. Inspect the recorded repository, source/tag, release URL and expected assets. Completion requires a visible published release and matching asset evidence. A draft release or partially uploaded assets remains incomplete.

Use the authenticated CLI for the same actions when needed: inspect `request schema`, fetch the current request, then submit a guarded command with the exact request revision, delivery run, input revision, candidate commit/digest and a unique operation ID. The [command table](../reference/worker-release-workflow.md#guarded-release-commands) names the merge, build, publish and reconcile actions. Preserve the command's payload when retrying a lost acknowledgement.

## Use guarded release commands

Inspect the current release state before acting:

```sh
node bin/apps/worker/cli.mjs request release --id REQUEST_ID
```

Use the request's numeric revision for `--if-match`, a unique command ID for `--key`, and a JSON payload identifying the exact `deliveryRunId`, `inputRevision`, `candidateCommit` and `candidateDigest`. The executable commands are `request merge`, `request build-release`, `request publish-release` and `request reconcile-release`:

```sh
node bin/apps/worker/cli.mjs request merge --id REQUEST_ID --if-match REVISION --key merge-1 --file candidate.json
node bin/apps/worker/cli.mjs request build-release --id REQUEST_ID --if-match REVISION --key build-1 --file candidate.json
node bin/apps/worker/cli.mjs request publish-release --id REQUEST_ID --if-match REVISION --key publish-1 --file release.json
```

Fetch the new revision after each completed action. `release.json` also carries the intended `releaseTag`. Reconciliation identifies the saved `releaseOperationId`; it observes rather than repeats that mutation. Use `request confirm-release-stopped` only after inspecting and stopping an uncertain build process, following the installed schema and its required note/identity fields.

## Recover without duplicating work

If an operation is pending or its outcome is unknown, choose reconciliation for that saved operation. Restore connectivity/authentication and policy approval first. Reconciliation reads the exact destination; it does not repeat the mutation.

A matching observed result resumes from the recorded milestone. A complete lookup establishing absence permits a separate new action. An incomplete lookup remains unknown. Existing differing branches, tags, releases or assets require inspection; they are not overwritten. Retained candidates, merge receipts and successful builds remain available after later-stage failure.

For unknown provider/build processes, inspect the host and follow [execution recovery](answer-and-resume-worker.md) before asserting they stopped. Operator attestation records an inspection; it does not manufacture a successful result.
