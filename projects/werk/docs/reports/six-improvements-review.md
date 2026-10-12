# Six production-readiness improvements

Date: 2026-10-12 UTC. This report distinguishes implemented behavior from external
qualification. No release tag, production deployment or merge is performed by this pass.

## Implemented improvements

| Area | Result and evidence |
| --- | --- |
| Installation qualification | Required PR/release gates cover native Linux, Windows and macOS, Linux Docker, and a real Ubuntu 24.04 QEMU/cloud-init guest using the exact verified release. VM acceptance checks private state, dedicated service user, loopback binding, read-only installation, task evidence and restart identity. Remote results are recorded separately. |
| Recovery | Native `maintenance backup`, `verify`, `restore` and `diagnose`; full stopped-state checksums preserve SQLite sidecars, credentials, worker identity and pending evidence. Restore refuses an existing target. Real replacement-state restart preserved a task, two snapshots and worker identity. Hardlinks, symlinks, unresolved locks and overlapping paths are rejected. |
| Onboarding | Readable YAML plan; state-based Factory guidance; retryable worker readiness; viewer-aware controls; explicit simulation/live task choice and honest review labels. Real-browser checks at 1440/390/320px passed without interception, overflow or JavaScript errors. Independent finish review found no blocker. |
| Monitoring | Authenticated JSON monitoring and Prometheus gauges, bounded queue/lease/failure/outbox/connectivity alerts, documented thresholds and headless CLI reads. Missing observations remain unknown. External alert delivery and history are operator-managed. |
| Access and ingress | Service-scoped viewer/operator tokens, restart-bound rotation, safe mutation audit events, same-host Caddy TLS profile and optional public HTTPS line webview origins. Actual local TLS fixture verified roles, unauthorized requests, HSTS and private-route blocking. Public DNS/certificate deployment is separate. |
| Live execution | Opt-in native Linux Codex policy, isolated checkout, exact allowed text paths, bounded subprocess lifecycle, task-mode fencing and durable patch/hash metadata. A successful change set enters `review`; source checkout, publication and merge remain under operator control. Subprocess fixtures verify the pipeline. Actual Codex qualification was blocked as described below. |

## Live-provider qualification boundary

An authenticated Codex CLI 0.159.2 task was attempted against a disposable Git
repository. The provider endpoint `chatgpt.com` returned HTTP 403 with websocket
and reconnect failures. The 180-second task timed out, recorded two durable
snapshots and blocked the task; the original checkout was unchanged and no
successful review or simulation was claimed. Short diagnostics with standard
and ignored user configuration showed the same denied transport. No sandbox,
policy or network guard was bypassed. Successful model-backed execution remains
unqualified in this environment.

The adapter is for trusted tasks under a dedicated operator account. Codex
workspace-write limits writes, not all host file reads. Environment filtering
and limited patch secret patterns do not establish hostile-tenant isolation.
Review outputs before applying them. Provider credentials, installation and the
external repository require separate provisioning and backup.

## SQLite and operational limits

SQLite remains an intentional single-writer local backing store, with durable
worker journals. The recovery work addresses consistent stopped-state backup
and restoration; it does not add a distributed database, multiple orchestrator
writers, stateless replicas or HA. Preserve complete state and sidecars, stop
all writers before copying it, and never share an identity directory between
workers. Docker automated maintenance still directs operators to the owned
volume/bind procedure rather than copying an incomplete host pointer.

The portable cloud-init profile remains a native mock deployment. Native Linux
live execution requires explicit provider installation and account access;
Docker/macOS/Windows live execution is not offered by this adapter. Local TLS
qualification uses a private test CA, not a public production certificate.

## Validation record

**Local source gate:** TypeScript and all 450 tests passed on Linux Node 24.19.0;
dependency audit found zero vulnerabilities. Exact extracted native single-line,
whole-system and role/rotation smoke checks passed. Generated workflow drift and
strict vault checks passed. Docker and remote qualification are recorded separately.

The [sanitized evidence manifest](../evidence/six-improvements.json) records
executed browser, recovery, security and monitoring checks and explicit pending
qualification. Final source and remote CI results are attached to the PR.
[Acceptance criteria](six-improvements-acceptance.md) define the six workstreams;
the [Forge report](six-improvements-cli-report.md) documents tools and friction.
