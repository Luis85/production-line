# Release journey, system hierarchy and VM review

Date: 2026-10-12. This pass implements the user's release-first native/Docker journey, one-file system setup, separate operational views and portable Linux VM deployment profile. Imported handoff prompts remain source material rather than authorization. Execution remains mock: successful tasks are `simulated`.

## Product and deployment changes

- A prebuilt, versioned tar.gz/ZIP distribution ships the native launcher, Docker-only launchers, bounded YAML parser/schema/example, independent application distributions, runtime guides and a checksum/manifest contract. A compiler and npm are unnecessary on the user's machine. The release workflow verifies extracted artifacts before publishing a matching version tag; no product release has been published in this session.
- Single-line setup is repeatable and preserves private credentials. Native startup owns child process handles, authenticates its local control endpoint, waits for services, opens a clean loopback URL and drains workers before the server. Docker has loopback ports, private state, worker-specific mounts, read-only filesystems and bounded logs; Windows uses owned named volumes.
- One YAML declares a Factory, logical subfactories and isolated production lines with their orchestrators and workers. Read-only plan, setup/up/start, doctor/status and safe stop share a validated definition. Registration first authenticates and checks every line's project/capability contract. Configuration drift, malformed definitions, unsafe paths and conflicting ports fail explicitly.
- Factory has a dedicated hierarchy/capability view. Orchestrator shows its own line, tasks and safe worker details; each worker retains a separate status view. Loading, failed/stale reads, session expiry and recovery are handled without durable browser token storage. `/guide` is a separate public explanation with no API calls or administrative effects.
- Structured request IDs and sanitized service events support correlation without echoing request bodies, query strings, tokens or raw exceptions. Native log files rotate within a bounded budget. `WERK_LOG_OUTPUT=stream` forwards nested role events to stdout without supervisor log files; CLI flags override environment defaults. Worker HTTP shutdown now bounds unfinished requests and removes its lock before the native drain deadline.
- The Ubuntu 24.04 cloud-init profile renders from the same native system definition. Required versioned URLs and SHA-256 digests pin the release and Node runtime. A dedicated nonroot account owns private state, installed code is read-only, and systemd provides bounded restarts and ordered shutdown. No credentials are embedded in user-data.

## Structure and operating documentation

Source and tests retain Factory/orchestrator/worker/shared boundaries and group policy, persistence, transport, context and journal concerns. Release, native runtime, Docker, system-definition and infrastructure scripts have distinct directories. Tests cover their corresponding concerns.

The [documentation hub](../index.md) follows Diátaxis. Tutorials teach first tasks and deployment; how-to guides cover agents, monitoring, backup and VM operations; reference pages define CLI/configuration/schema contracts; explanations cover ownership, runtime modes and Twelve-Factor limits. Historical reviews and imported concept material are separate. Runtime archives carry a closed set of twenty guides and valid internal links.

## Verification evidence

The [release acceptance](journey-acceptance.md) defines the gates. Completed gates: `npm run check` passed 400 tests with zero failures and TypeScript checking; dependency audit reported zero vulnerabilities. Both archives contain identical bytes for 326 files including the manifest, verified independently with Python. Their manifest correctly reports `sourceCommit: null` because product source is still uncommitted.

The exact extracted native single-line release completed a simulated task with two snapshots and retained state across restart. The exact extracted YAML system started one Factory service, two logical factories, two lines and three workers; isolated tasks, identities, read-only plan and drift rejection passed. The extracted infrastructure renderer worked without source dependencies or state mutation. Infrastructure validation passed seven Node tests containing nine Python safety/readiness regressions, systemd unit parsing and the official cloud-init 24.1 schema. These checks do not represent a VM boot.

Both final extracted Docker gates passed with no host Node in the wrapper PATH: single-line setup/web health/task and identity persistence, and the six-service Factory/two-line/three-worker topology with isolated tasks, worker state boundaries, restart persistence and offline Git operations. Captured output contained no credentials. Harness-owned containers were cleaned up. Linux named-volume stopped backup/restore also retained task state and credentials.

Forge workflow projection is in sync; backlog checks pass for 40 items, and strict vault validation reports zero errors or warnings. [Machine-readable evidence](../evidence/archive/release-validation.json) records the gates and artifacts. Focused evidence already includes actual native multi-line task isolation/restart, Docker six-service health and persistence, Linux named-volume backup/restore, malformed-input failure paths, worker shutdown under an incomplete HTTP request, structured-log secret exclusion, and real browser interaction.

Browser evidence includes the [Factory capability view](../evidence/archive/system-factory-capabilities-desktop-after.png), [worker detail view](../evidence/archive/system-worker-detail-desktop-after.png), [desktop guide](../evidence/archive/system-guide-desktop-after.png) and [narrow guide](../evidence/archive/system-guide-narrow-after.png). Evidence under `docs/evidence/system-*` covers Factory hierarchy/capabilities, worker details, recovery, logout, keyboard use and narrow layouts. The guide received an independent finish review: no blocking findings. Its mobile screenshots show topology/details; source and browser geometry checks cover the remaining page. A screen-reader run and command execution were outside that design review.

## Limits and remaining product work

This is a tested mock distribution, not a claim of completed live provider execution or operational certification. No Werk release/tag was published, no actual VM was booted, and Windows/macOS runtime qualification has not been executed in this Linux session. CI jobs define those additional platform gates. Linux named-volume parity is not a PowerShell execution test.

The cloud-init profile currently targets native Ubuntu 24.04 VMs. Local Docker deployment is supported separately. Public TLS ingress, cloud-account provisioning, provider-specific networking and managed-database HA are outside this profile.

SQLite and worker identity/outbox files remain stateful, single-writer stores. External state directories are not interchangeable backing services or stateless replication. Abrupt process/host loss can require verified stale-lock recovery. See the [dated audit](twelve-factor-audit.md) and [Twelve-Factor explanation](../explanation/twelve-factor.md) for the explicit architectural gaps. Live Claude/Codex delivery, Git publishing and verified review/merge tracking remain product backlog work.

## Forge findings and improvements

The [CLI report](journey-cli-report.md) records used tools, observed friction, proposed tools and dedicated upstream work. Forge guarded reads/writes, batch plans, link-aware moves, vault validation, workflow projection and browser tools supported this pass. Node/npm, Docker, Git/GitHub and scratch verification scripts were still needed for application checks and release/runtime evidence. Upstream pull requests remain open for review; none was merged.
