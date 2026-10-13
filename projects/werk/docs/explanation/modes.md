# Execution modes and what their results prove

Werk defaults to simulated execution. Native Linux deployments can explicitly
enable a narrow Codex CLI adapter that produces a local patch requiring human
review. Deployment mode and task execution mode are separate decisions.

## Simulated work

A successful mock task ends as **simulated**, never `done`. It proves that intake,
assignment, lease handling and evidence delivery completed for that attempt. It
does not prove that code changed, feature checks passed, a PR opened or a change
merged. Claude/Codex labels on mock profiles select simulated configuration; they
do not invoke either provider.

## Live Codex work

Both the operator's worker configuration and the task must opt into `cli` mode.
The scheduler matches project, provider and execution mode. A mock task cannot
be claimed by a live profile. The implemented adapter supports native Linux,
one Codex profile, one slot, one attempt and an exact operator-managed file
allowlist. Follow [run a Codex task](../how-to/run-codex-task.md).

The worker pins committed local repository data, clones an isolated checkout,
invokes the trusted Codex executable with the workspace-write sandbox, and
validates a bounded text patch. The source checkout stays unchanged. Managed
runtime settings and authentication routing remain the operator's concern;
Werk never copies provider credentials into evidence. The host account must be
trusted and dedicated: workspace-write does not provide hostile-tenant read
isolation from other files accessible to that account.

A successful live attempt ends as **review** with a **change-set** snapshot.
Private worker state retains the patch and manifest; the orchestrator retains
its base commit, hash, size and artifact path. The result requires human
inspection and independent checks. There is no automatic apply, PR, approval or
merge, and no automated review/rework cycle. Timeout, process failure, invalid
patch or lost ownership cannot be reported as a successful review result.

Unknown token use, cost and independently measured quality remain null or
unavailable in both modes. Local process measurements are not precise per-task
model usage. The legacy quality values `not_run` and `not_evaluated` mean Werk
has no independently collected checks; an agent may have attempted commands
without producing verified quality evidence.

## Deployment and qualification

Native deployment runs packaged Node applications directly; Docker runs them in
containers. The shipped Docker profile remains simulated. Docker Agent's
optional MCP integration is also separate from the live worker adapter.

The live adapter's process, patch, lease, journal and failure paths have automated
integration coverage using controlled subprocess fixtures. A real authenticated
Codex CLI 0.159.2 invocation was attempted in the managed qualification
environment; the initial attempt timed out and correctly produced blocked/failed
evidence, not a success claim. A subsequent bounded diagnostic identified HTTP
403 responses from `chatgpt.com`, followed by websocket/request retries and stream
disconnection. No DNS/TLS error code was observed, and normal user configuration
produced the same failure. No network or policy bypass was attempted. A fixture-backed process test is not proof of
provider availability on an operator's machine. Consult the current review
report for later qualification results.

Default intake preserves a requirement wikilink without resolving it. An
operator-configured server binding can instead validate committed requirement
context and persist a manifest for the worker to verify. That context binding
does not itself authorize execution or publication.

Use [local first task](../tutorials/local-first-task.md) or
[Docker first task](../tutorials/docker-first-task.md) for the simulated flow,
and [security boundaries](../reference/security.md) when planning remote access.
