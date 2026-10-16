# Execution modes and what their results prove

Werk has separate orchestrator assignment and local worker execution paths.
Deployment mode (native Node or Docker) does not select a provider or authorize
publication. Simulation remains the default for orchestrator assignments.

## Orchestrator assignments

A successful mock assignment ends as **simulated**, never `done`. It proves that
intake, leasing and evidence delivery completed. Claude/Codex labels on mock
profiles select simulated configuration; they invoke neither provider.

Both worker configuration and task must opt into `cli` for native execution.
The scheduler matches line project, repository capability, provider and execution
mode. This adapter supports native Linux, one Codex profile, one shared execution
slot, one attempt and an exact operator-managed file allowlist. It selects
`task.repository`, falling back to `task.project`, from the worker's assignments;
legacy single-repository configuration remains supported when no assignments
exist. Follow [run a Codex task](../how-to/run-codex-task.md).

The worker prepares a retained Git worktree from committed data, including an
exact pinned source/context commit when supplied. During model execution it
uses private Git metadata and the trusted Codex executable's workspace-write
sandbox; trusted postprocessing validates the bounded patch. Provider changes
remain in that worktree. The ordinary repository watcher may separately
fast-forward a clean assigned base; shared-intake bindings preserve their base. The host account must be trusted: workspace-write does not
isolate reads from other files accessible to that account. See the recovery and
host-boundary details in [security](../reference/security.md).

A successful native assignment ends as **review** with a **change-set** snapshot.
Private worker state retains the patch, manifest and worktree; the orchestrator
retains artifact provenance. This assignment path does not push a branch or open
a PR. Timeout, invalid patch, process failure or lost ownership cannot become a
successful review result. Provider token/cost fields and independent project
check measurements remain unavailable in these leased snapshots.

## Local worker chat and approved-file tasks

The authenticated Taskboard can use configured OpenAI/Anthropic API connections
or host-installed provider CLIs. Local Codex CLI requires POSIX; Claude Code CLI
supports Linux, macOS and native Windows. Windows Claude execution uses supervised
Job Object descendant cleanup. A supported process path is not proof that a
particular account, endpoint or CLI installation is available.

Local execution shares the worker's one slot with parent assignments. Chat gets
its supplied messages and operator-granted tools. Approved-file tasks capture
bounded immutable input from a retained worktree, and return a validated patch
for review. A provider response does not directly apply that patch to the source
checkout. Legacy unassigned non-Git directories retain the bounded read-only
snapshot path. Installed-repository discovery requires an explicit saved choice
before that checkout can be used or watched.

Provider-native tools remain disabled for this local conversation path; Werk
mediates approved built-in/MCP tools and preserves grants, revocation and typed
interaction events. A model cannot authorize its own tool access. CLI
restrictions and supported versions are in the
[model interaction contract](../reference/model-interaction.md).

Local run evidence records reported usage and its source where available.
Unknown usage, independent quality and subscription allocation remain unknown;
model statements that tests passed do not count as independent check evidence.
See [worker run metrics](../reference/worker-run-metrics.md).

## Shared Git feature intake

A worker can bind a team repository's ready queue, workflow template and ready/done
checks. It confirms a durable remote claim before admitting a task, freezes the
source commit and checks, and uses the local approved-file path. After canonical
done evidence matches the validated patch, it publishes a scoped feature branch
and an Obsidian review note. Publication retries reconcile the journal and remote
acknowledgments without re-executing completed work.

The bound developer checkout, branch and index remain unchanged; watching that
binding fetches status without advancing its original branch. Shared publication
uses the configured host Git authentication. Human review and merge remain
separate; a published branch or completed local request does not prove merge,
deployment or independent project-test success. This workflow is separate from
a future lease-fenced orchestrator PR publisher. Follow
[shared feature intake](../how-to/shared-feature-intake.md) and its
[reference](../reference/shared-feature-intake.md).

## Deployment and qualification

Native deployment runs packaged Node applications. Docker runs them in
containers; the stock image has no signed-in host provider CLI. Its orchestrator
execution profile remains simulated, while an independently configured local
worker can use API providers. Docker Agent's optional MCP integration is another
explicitly configured interface.

Automated tests use controlled provider subprocesses or protocol fixtures for
failure, cancellation, gates and publication recovery. The two-clone shared Git
journey exercises actual repository claims and pushes with a fixture provider.
Neither is evidence of live account availability. An earlier authenticated
Codex diagnostic received HTTP 403 from `chatgpt.com`; that dated observation
neither qualifies nor rules out another operator's deployment. Consult the
release review history and [qualification results](../reference/releases.md) for
completed checks and environment limits.

Use [local first task](../tutorials/local-first-task.md) or
[Docker first task](../tutorials/docker-first-task.md) for a simulated flow.
