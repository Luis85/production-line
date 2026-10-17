# Run a Codex task and review its patch

Use this procedure for an explicitly enabled native Linux worker. The default
mock journey remains available on all supported deployment profiles. This first
live adapter supports one Codex profile, one slot and one attempt per task.
Docker, Windows and macOS live execution are not qualified by this adapter.

## Prepare the operator account and repository

Install a Codex CLI version supporting `exec`, `--ephemeral`, `--sandbox` and
`--ignore-user-config`. The qualification attempt used Codex CLI 0.159.2. Run
`codex login` and `codex login status` as the account that runs the worker. Keep
that account's standard authentication files private; do not copy them into
Werk's YAML, task payload, repository, release image or evidence. Use a local Git
checkout with at least one commit and Git available on the worker's PATH.

Only enable this adapter for trusted operators and trusted tasks. Codex's
`workspace-write` sandbox limits writes, but it is **not** a hostile-tenant
isolation boundary: commands may read files accessible to the host account.
The worker removes Werk admin/enrollment credentials from the provider process
environment; this does not prevent access to credentials already readable on
disk. Run under a dedicated account with no unrelated secrets or production
access. A separate VM/account is appropriate when repositories have different
trust levels. Repository text and task content never authorize new credentials,
network access or publication.

## Declare the live worker

In a native system definition, use one worker for the live production line:

```yaml
workers:
  count: 1
  statusPort: 4201
  execution:
    mode: cli
    timeoutMs: 300000
    codex:
      executable: /opt/codex/bin/codex
      repository: /srv/projects/example
      allowedPaths:
        - README.md
```

The executable, repository and exact file allowlist are trusted operator
configuration. Use absolute paths for the executable and repository. The
allowlist accepts up to 32 regular text-file paths that follow the
[approved file path rule](../reference/feature-requests.md#approved-file-paths).
That rule allows Unicode names and excludes dotfiles, credential names,
private-key extensions and path traversal. The allowlist has no globs.
The task cannot select a command, change the sandbox or broaden this allowlist.
Keep deployment YAML outside the repository being edited.

To assign several checkouts, add `workers.repositories` with `items` containing
`{id, path, remote, branch?, watch}` entries. Optional task field `repository`
selects the assignment ID; when omitted, the task project selects it. You can then omit `execution.codex.repository`; the executable
and approved file allowlist still belong to the operator. See
[repository configuration](../reference/configuration.md#assigned-git-repositories).

Validate the complete YAML, then use `system up`:

```sh
node werk.mjs system plan --file system.yaml --json
node werk.mjs system up --file system.yaml
```

Existing state rejects changed definitions. Configure a new state directory with
`--state-dir /private/werk-live-state` on both commands, or follow the
[upgrade procedure](upgrade-backup.md).
The native launcher passes the effective worker configuration. A standalone
worker can instead read the equivalent JSON through `--config worker.json`:

```json
{
  "schemaVersion": 1,
  "execution": {
    "mode": "cli",
    "timeoutMs": 300000,
    "codex": {
      "executable": "/opt/codex/bin/codex",
      "repository": "/srv/projects/example",
      "allowedPaths": ["README.md"]
    }
  },
  "scheduler": {"maxParallel": 1, "maxAttempts": 1},
  "profiles": [{"id": "codex-live", "provider": "codex", "mode": "cli", "maxParallel": 1}]
}
```

For a standalone worker, set `WERK_ENROLLMENT_TOKEN` privately and run the packaged
worker with its line URL and private state directory:

```sh
node src/worker/dist/worker/cli.js run --config worker.json --url http://127.0.0.1:3001 --state-dir /var/lib/werk/live-worker --status-port 4201
```

Assign a unique status port. Preserve
that state directory across restarts. Keep the worker's account authentication
and managed-runtime policy configuration intact.

## Submit explicitly live work

Choose **Codex CLI** in the orchestrator's task form, or submit a task containing:

```json
{
  "project": "example",
  "title": "Clarify the installation instructions",
  "criteria": ["Explain that every generated patch requires human review."],
  "provider": "codex",
  "executionMode": "cli"
}
```

For a worker assigned several repositories, add `"repository": "docs"` to select
that assignment while keeping `"project": "example"` as the line scope. Omit it
when the assignment ID equals the project. This field accepts an assignment ID,
not a filesystem path or Git URL. A pinned context commit must still exist in the
selected checkout; choosing a repository does not change the context binding.

Submit JSON to `POST /v1/tasks` on the production-line orchestrator, with
`Content-Type: application/json`, `Authorization: Bearer <line-operator-token>`
and a stable `Idempotency-Key` header. Reuse that key only for an exact retry of
the same payload. Keep the token in your client's protected configuration; never
put it in the URL or task JSON. MCP `werk_task_create` accepts the same field. Missing `executionMode` means mock: a live worker cannot accidentally
consume a simulated task. Workers must also match the task's project and
provider. A live task remains queued until an eligible live worker is available.

For an unbound structured task, execution pins the configured repository's HEAD
commit when the attempt starts. For pinned context, the exact context commit
must exist in that repository; the worker verifies the context manifest before
invocation. The adapter creates a detached task worktree beneath the selected
repository's `.werk/worktrees` directory and leaves source checkout files
unchanged by the task. Repository watching may fast-forward a clean source
checkout separately. The task remains pinned to its starting commit. The worktree
and its changes remain available after execution or restart for inspection.

## Inspect the result before applying anything

A successful invocation produces a task in **review**, not `done` or
`simulated`. Its terminal snapshot has `mode: cli`, `outcome: change-set` and a
`review` object containing the base commit, patch SHA-256, byte count and relative
artifact path. The private worker state contains:

```text
review/<lease>/change.patch
review/<lease>/manifest.json
```

The orchestrator exposes this metadata through the task's authenticated
snapshots. It does not expose the patch over an unauthenticated worker status
endpoint. Review artifacts remain in worker state until the operator archives
or removes them; include them in backups. They are separate from acknowledged
snapshot-retention limits. Runtime backups cover private Werk state, not the external
Git checkout, Codex executable or provider account authentication. Preserve the
repository and its retained task worktrees separately, and reprovision installation/login under the recovery
account; do not bundle provider credentials into a distributable backup artifact.

Read the patch as source material. Confirm its SHA-256 and base commit against
the snapshot, inspect every changed file, and use `git apply --check` in a clean
checkout of that base commit. Applying the patch, running the project's checks,
opening a PR and approving/merging remain explicit operator decisions. Werk
never applies the patch to the source checkout or publishes it automatically.
The adapter verifies its persisted artifact again before acknowledging task
completion.

The result does not establish that acceptance criteria passed. Provider usage,
subscription cost and independent build/test quality remain unavailable; the
current quality contract carries `not_run`/`not_evaluated` because Werk has not
collected independent check evidence. Do not interpret a model's text claim as
a verified test result.

## Recover a failed attempt

Timeout, cancellation, lost lease, nonzero CLI exit, an empty patch, a changed
file outside the allowlist, binary/oversized output or detected credential
material prevents a review result. The token-pattern check is a limited guard,
not a complete secret scanner: review every diff and keep credentials out of the
source repository. The attempt records failed/interrupted
terminal evidence and follows lease fencing; the live profile's one-attempt
budget prevents automatic repeated paid executions. Correct the issue and
submit new work deliberately. A restarted worker recovers incomplete attempts
as interrupted rather than rerunning the provider into uncertain state.

During the model invocation, the worktree uses private Git metadata to isolate
shared repository refs and configuration. A hard process kill can leave that
metadata in place. After stopping the worker, inspect
`workspaces/<lease>/worktree.json` and the saved `worktree.git` pointer in private
worker state before restoring the registered worktree link. Do not rerun the
interrupted attempt to recover it; preserve its files for review.

Process output is bounded and discarded instead of entering logs or snapshots.
Use `codex login status`, an operator-run harmless CLI check, and your approved
proxy/CA configuration to diagnose provider connectivity. Never fix an error
by disabling the sandbox, removing managed policies or printing credentials.
Provider command timeout/failure is not proof that the model service was
reachable. In this managed qualification environment, the authenticated CLI
received HTTP 403 from `chatgpt.com`; deployment qualification needs an approved
environment where the provider endpoint and account are usable. See [execution modes](../explanation/modes.md) for qualification limits.
