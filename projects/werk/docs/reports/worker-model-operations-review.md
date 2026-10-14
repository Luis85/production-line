# Worker model lifecycle, integration and operations review

Reviewed 2026-10-14. This pass follows the package-to-feature-to-metrics journey
with six delegated research, implementation, product, browser and independent
review roles. It extends the earlier worker atlas and system journey pass.

## Result

The worker owns a durable model dispatch contract, explicit questions and
escalations, guarded continuation, and per-attempt consumption. The interface is
available to the UI and JSON CLI. Project skills connect external Claude/Codex
agents to these operations. Long-running calls have explicit budgets and process
resource warnings. Local state remains single-owner by design.

### Model interaction and recovery

- Freeze provider identity, model, instruction, messages, capabilities and
  rendered prompt in a private dispatch before invoking the model.
- Normalize completed results, structured questions/escalations, safe failures
  and available usage. A question releases the execution slot and stays attached
  to the request, with a generated Markdown companion for folder intake.
- Fence answers, cancellation and continuation using revision plus stable
  operation identity. A retried identical command cannot create another call;
  stale or conflicting commands fail explicitly.
- Persist results before UI/feature projections. Restart reconciles known
  results without inference; uncertain interrupted calls require explicit
  continuation from retained context. Native provider session resume is not
  implemented or advertised.
- Expose versioned polling events and private dispatch inspection. Usage events
  carry cumulative observations; cost estimates, unknown values and provider
  coverage remain explicit. No subscription balance is inferred.

See the maintained [interaction contract](../reference/model-interaction.md),
[answer/resume guide](../how-to/answer-and-resume-worker.md),
[model research](worker-model-research.md) and
[subscription research](worker-subscription-research.md).

### Project integration

Initialization seeds `.claude/skills/werk-worker/SKILL.md`,
`.agents/skills/werk-worker/SKILL.md` and `.codex/werk-worker.md` when safe and
missing. The Codex skill explicitly reads the guide; the guide is not claimed to
be automatically discovered. Templates teach request submission, question
handling, guarded continuation, event polling, consumption interpretation and
resource inspection. Existing host-agent permissions remain authoritative.

Plan/sync use fixed paths, a canonical-project-bound plan hash, ownership hashes,
regular-file checks and an exclusive lock. User edits conflict; malformed
ownership or unsafe paths fail closed. Interrupted writes retain a checkpoint
and require explicit stale-lock recovery after verifying every writer stopped.
This is not a crash-atomic multi-file transaction. Worker provider subprocesses
retain their restricted execution boundary and ignore project customizations.

See [project integration operations](../how-to/project-agent-integrations.md).

### Long sessions and monitoring

Local invocations default to six hours, configurable up to 24 hours. The budget
is frozen per dispatch; an explicit answer/resume captures the current limit.
The authoritative `WERK_WORKER_MAX_RUNTIME_MS` environment override exposes its
source and preserves the saved setting. UI edits to that limit are rejected
while the override is active. Scoped HTTP transport removes hidden response
header/body deadlines while retaining invocation cancellation and a bounded
initial connection. No inference retry is added.

A ten-second sampler measures worker Node RSS, heap, CPU, state-filesystem space
and active elapsed time. Sustained pressure and duration warnings have hysteresis,
durable opening/resolution events and explicit unknown/error states. The latest
1,000 transitions are retained with cursor-gap reporting. UI, CLI, structured
logs and aggregate public metrics use the same monitoring boundary. Warnings
never cancel or retry work. Shutdown drains the sampler before journal close.

See [long-running operations](../how-to/monitor-long-running-worker.md).

## Applicable twelve-factor review

The review used the [official methodology](https://12factor.net/). The maintained
[explanation](../explanation/twelve-factor.md) records the product boundary.

| Factor | Applied improvement or verified boundary |
| --- | --- |
| I. Codebase | One reviewed source change; independently packaged applications and source metadata. |
| II. Dependencies | Pinned production transport dependency, locked install, bundled portable runtime and vulnerability audit. |
| III. Config | Explicit environment execution override/source, validated bounds, preserved private settings and documented precedence. Credentials stay out of integrations and event payloads. |
| IV. Backing services | Typed model port separates application policy from CLI/API adapters. SQLite/files remain local backing state. |
| V. Build/release/run | Prebuilt archives include transport dependencies and operational guides; startup requires no npm/build. |
| VI. Processes | Durable prompts, results, questions and journals survive restarts. The worker intentionally requires persistent state. |
| VII. Port binding | Existing authenticated loopback service exposes bounded resource and integration APIs. Readiness is not model progress. |
| VIII. Concurrency | One execution permit per worker; independent workers scale with separate identities/state. No shared-disk replica claim. |
| IX. Disposability | Cancellation, journal reconciliation, unreferenced monitor timer and drained shutdown. Ambiguous calls never silently replay. |
| X. Dev/prod parity | Native and Docker qualification uses the same extracted archive and copied worker implementation. |
| XI. Logs | Fixed structured alert transitions; durable bounded event history remains separate from supervisor/collector retention. |
| XII. Admin processes | Reviewed integration plan/sync and resource CLI operate through the same release and ownership rules. |

Primary references: [config](https://12factor.net/config),
[dependencies](https://12factor.net/dependencies),
[build/release/run](https://12factor.net/build-release-run),
[processes](https://12factor.net/processes),
[concurrency](https://12factor.net/concurrency),
[disposability](https://12factor.net/disposability),
[logs](https://12factor.net/logs), and
[admin processes](https://12factor.net/admin-processes).

## Independent review findings resolved

Review found and fixed cross-project reuse of integration plan tokens; invalid
resource readings being interpreted as healthy; CPU baselines surviving invalid
samples; wall-clock jumps repeatedly opening elapsed warnings; hidden short
execution/HTTP limits; and misleading timeout/environment labels. Regression
coverage exercises behavior at each boundary. Existing recovery checks also
cover accepted-answer admission failure, delayed cancellation racing a newer
turn, patch-to-chat continuation and results checkpointed before projection.

## Verification

- Typecheck passed. All three applications were rebuilt. Final suite: **762 tests, 761 passed, zero failures, one PowerShell-specific skip**.
- Production and full dependency audits: zero vulnerabilities.
- Extracted archive: 1,435 verified files; generic native, Docker without host Node, native project and Docker project journeys passed. Extra copied-app checks verified non-Git integration roots, guarded dry runs/conflicts, bundled provider transport and resource commands.
- Final visual spacing refinement rebuilt the worker; all non-public-asset package entries remained byte-identical to the four-journey candidate. Focused interaction/resource UI tests: 13 passed.
- The [interactive model journey](worker-model-interaction-journey.html) contains 12 embedded screenshots over seven stages, including restart, question answers, stopped escalation, continuation and consumption. See [browser observations](../evidence/worker-model-interaction-browser-results.json). The subsequent shared Vue migration has its own browser verification.
- [Sanitized qualification evidence](../evidence/worker-model-operations-qualification.json) records the final package and CLI observations.
- Generated workflow sync and Git whitespace checks passed. Maintained documentation links passed strict validation; temporary scratch files are excluded from final deliverables.

## Limits

Provider protocol and browser journeys use deterministic local executable
fixtures. No paid Claude/Codex/OpenAI inference, subscription billing, real
24-hour soak, provider-child resource accounting, cloud failover or shared-state
replication was qualified. Native provider session resume and token streaming
remain unsupported. Subscription integration recommendations are research, not
an implemented custom OAuth client. CPU normalization uses available parallelism,
not measured cgroup quota. Missing measurements are unavailable, and readiness
fails if a required resource journal cannot initialize.

The worker intentionally does not claim full stateless twelve-factor compliance.
Back up stopped complete state, and keep only one active owner per worker identity.
