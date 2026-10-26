# Production hardening report

Latest work: [Continuation review](continuation-review.md) records 226 passing tests, the context command, pagination, retention and recovery improvements.

Reviewed on 2026-10-12 using The Forge 0.1.0, Node 24.19.0 and six parallel review agents, followed by reciprocal code review and a coherent integrated test run.

## Result

The runnable mock foundation has been hardened. It is not yet a production live-agent delivery service. Real provider execution, commit-pinned requirement resolution, fenced Git publication, current-head PR checks, human review/rework and merge reconciliation remain unimplemented. The original 14 implementation items stay Open; completing this hardening pass does not complete those features.

## Implemented changes

| Area | Finding and change | Verification |
| --- | --- | --- |
| HTTP security | Reject missing/ambiguous/non-Bearer credentials consistently; accept case-insensitive Bearer; return structured errors for oversized/invalid JSON; handle aborted uploads; serialize before committing response headers; contain outbound requests to their configured origin and reject redirects | 12 new real-HTTP security regression tests plus existing API tests |
| Orchestrator | Replace whole-queue decoding with indexed, affinity-filtered SQL selection; preserve FIFO/priority and profile capacity; check snapshot assignment within the write transaction; close active connections on shutdown deadline and release SQLite resources | 5 new tests; regression goes from 203 decoded payloads to 2; concurrent processes claim 16 distinct leases; partial-upload shutdown and reopen |
| Worker | Reject symlinked journal paths and mismatched snapshot identities; cap file reads; flush sequentially; detach queued snapshot data; validate registration before persisting; stop terminal retries after lease loss | 8 new regressions; existing crash/replay/lease coverage |
| Factory and operations | Bound polling queue and cancellation; deadline-limited shutdown; upgrade yaml 2.8.1 to 2.9.1 for GHSA-48c2-rrv3-qjmp; add npm check and dependency audit; add pinned-action CI and service container builds; support an optional build-only proxy CA secret | 5 new regressions; dependency audit zero findings; three real container builds and health smoke checks |
| UI | Focus workspace after Factory authentication; prevent duplicate keyboard auth submissions and reset cancelled controls; validate worker responses before DOM changes; retain good data on failure; add keyboard-accessible labeled scroll regions and skip link; avoid noisy polling announcements | 4 new UI tests, 23 existing focused tests; desktop/mobile Chromium checks |

The imported ZIP and original import manifest remain intact as provenance. Working source changes are intentional and now differ from that baseline.

## Integrated evidence

- `npm ci --ignore-scripts`: passed.
- `npm run check`: TypeScript, all three independent builds and **176 tests passed**, 0 failures or skips (baseline: 142 tests).
- `npm run audit:dependencies`: 0 known vulnerabilities at review time.
- Three Docker images built. Factory, orchestrator and worker reported healthy with UID 1000, read-only filesystem, no-new-privileges and all capabilities dropped. Worker enrollment and mock overview were verified. Temporary containers and network were removed.
- Optional proxy CA was absent from running images; TLS verification stayed enabled during builds.
- Browser checks: Factory, orchestrator and worker at desktop 1440px and mobile 390px; no document overflow or page errors. Malformed worker-response recovery and authentication focus were exercised.
- Reciprocal source review of HTTP, scheduling and worker behavior found no additional blocking regression in the reviewed diff.
- Generated GitHub workflow is maintained by `workflows sync`; its drift check passes. CI defines Linux, Windows and macOS checks and all three image builds; remote CI has not run for this local source.
- Forge strict vault and backlog checks are final handoff gates. No production deployment or real provider credentials were used.

## Visual evidence

- [Before](../evidence/archive/ui-before.png).
- Factory: [desktop](../evidence/archive/factory-desktop-after.png), [mobile](../evidence/archive/factory-mobile-after.png).
- Orchestrator: [desktop](../evidence/archive/orchestrator-desktop-after.png), [mobile](../evidence/archive/orchestrator-mobile-after.png).
- Worker: [desktop](../evidence/archive/worker-desktop-after.png), [mobile](../evidence/archive/worker-mobile-after.png).

## Remaining production blockers

1. Implement and verify the live acceptance matrix in [the source acceptance criteria](../handoff/acceptance.md) and the [implementation plan](../handoff/implementation-plan.md), especially pinned context, real adapters, publication fencing and the review/merge lifecycle.
2. Define journal/evidence retention and recovery checkpoints. Journal filename inventory and historical replay remain proportional to retained history. Task/worker list APIs remain unpaginated. Sustained load, disk exhaustion, outage recovery, backup restoration and deployment SLOs still need dedicated verification.
3. Configure and test deployment-specific TLS, credential rotation, provider/Git-host permissions, monitoring and operational ownership. The managed environment had no configured provider secrets or outbound identities.
4. Run the cross-platform CI and broader browser/screen-reader coverage. Local verification here used Linux and Chromium; hostile concurrent filesystem swaps are outside the journal path-check guarantee.

## CLI feedback

See [Forge tool usage and improvement report](cli-improvement-report.md) for verified tool coverage, friction, reproductions and the selected upstream PR scope.
