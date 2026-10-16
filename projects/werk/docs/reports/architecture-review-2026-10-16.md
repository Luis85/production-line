# Architecture and shared-boundary review — 2026-10-16

This review started from Werk 0.7.0 on `refactor/architecture-and-shared-boundaries`.
It covers Factory, orchestrator, worker, shared contracts, process/HTTP/Git
adapters, webview state, packaging and regression tests. The objective was to
remove repeated mechanics and invert concrete dependencies where they obstructed
policy tests or lifecycle guarantees. It was not a rewrite of service ownership
or a claim that the whole architecture is now independent of infrastructure.

## Findings and decisions

Evidence paths below refer to the resulting source; the described defects were
observed against the pre-refactor baseline. P1 means correctness or resource
ownership risk, P2 means a concrete maintenance/interface defect, and P3 means a
bounded follow-up with no demonstrated production failure in this review.

| Priority | Evidence and consequence | Decision and resulting boundary | Validation status |
| --- | --- | --- | --- |
| P1 | `factory/server.ts`, `orchestrator/server.ts`, `worker/runner.ts`: a failed constructor or earlier close could bypass later cleanup; the worker lock did not span all construction | Shared `lifecycle.ts` settles every owned resource and preserves the primary failure; HTTP lifecycle owns full handler promises, cancels owned upstream I/O and settles handlers before closing databases | Lifecycle and constructor failure fixtures passed in isolated compiled checks; integrated qualification is recorded below |
| P1 | `repositories-git.ts`, `features/git-io.ts`, `repository-discovery.ts`, orchestrator `git-environment.ts`: inconsistent ambient `GIT_*` handling could redirect metadata or config; remote helpers and filters could outlive plain Windows launches | Explicit host/immutable environment profiles plus contained launches whenever Git may execute descendants; ordinary host authentication remains available; plain metadata disables promisor lazy fetch and machine logs disable configured signature verification | All 10 Git process-boundary tests passed on Linux, including real helper/filter termination, injected environments, promisor lazy-fetch and signed-log regressions for both adapters; native Windows remains a separate CI gate |
| P2 | Provider-neutral file admission used fake Codex configuration validation and could turn invalid paths into HTTP 500 | `application/approved-paths.ts` owns path policy with semantic validation errors; adapters enforce filesystem identity separately | Focused application-port and admission tests passed |
| P2 | Worker `application/sessions.ts`, `local-tasks.ts`, `definitions.ts` instantiated concrete file/provider/journal adapters; remote/reconcile gates and account policy imported infrastructure types | Purpose-specific `provider-contract.ts`, `workspace-ports.ts`, `journal-ports.ts`; concrete setup belongs to Workspace/infrastructure; the entire worker application directory now has no adapter imports, including types | AST source scan passes with no application exception list; behavioral port and existing workflow tests remain required |
| P2 | `orchestrator/infrastructure/interaction.ts` combined interaction policy with authenticated HTTP and weak response typing; Factory forwarded that interaction | Pure `shared/worker-interaction.ts` request/response/command DTOs and validators; extracted application use case takes `WorkerInteractionPort` and checks worker/session identity | Isolated interaction use-case and cross-service security regressions passed |
| P2 | Repeated stream concatenation/limits across shared clients, Factory polling/delivery and provider API risked inconsistent overflow/cancellation handling | `shared/http/response-body.ts` owns bounded byte collection; each adapter retains its byte budget, UTF-8/JSON rules, status interpretation and safe errors | New bounded-stream fixtures and adapted client/security regressions passed in focused checks |
| P2 | Provider account/status each owned private cwd, command resolution and contained CLI probing; status lacked shutdown | `provider-process.ts` shares command/environment/probe mechanics; caches, output parsing and disclosure remain separate; Workspace closes status probes | Focused provider/cleanup fixtures passed on Linux; Windows provider behavior requires native CI |
| P2 | Four worker journals repeated private SQLite file/WAL/SHM checks and configuration; configuration failure could leave handles open | `journal/database.ts` owns safe opening/configuration/close-on-failure; each journal retains its schema, transactions, migration and recovery authority | Isolated compiled journal suites passed, including new permissions/schema failure/retry cases |
| P2 | `tests/architecture/architecture-boundaries.test.mjs` formerly inspected only relative declaration/string-import edges and allowed every same-service import | Reusable AST graph checks type edges, CommonJS/createRequire, literal template imports, aliases, absolute/file paths and Vue scripts; protected application and pure-contract policies reject adapter edges | 27 architecture/provenance/source-Docker tests pass against the combined build; forbidden dependency fixtures exercise the same policy as the source scan |
| P2 | Snapshot `workerVersion` and MCP `serverInfo.version` were hardcoded `0.1.0` while root/package artifacts were `0.7.0` | Root manifest generates deterministic per-app `shared/build-info.js` at staging; source fallback is explicit `development`; consumers perform no runtime source/package lookup | Built/portable outer and inner manifests, actual Factory/line MCP handshakes and new snapshot versions agree with 0.8.0; the three provenance tests pass |
| P2 | The provenance generator became a static build dependency, but all three source Docker build stages copied only the previous helpers | All three Dockerfiles now copy `scripts/build-info.mjs`; source-context tests resolve the actual script import closure and the worker-only authoring dependency | Four focused tests pass, including missing and transitive helper negative fixtures; these checks do not claim a Docker image was built |
| P2 | Element-specific environment setup was absent, leaving local unlock credentials and startup defaults scattered between private state and command flags | One portable environment helper serves all three apps; initialization adopts existing credentials, local launch boundaries load only supported keys, and intentional stopped-start rotation synchronizes actual private state | Environment helper tests passed 15/15, CLI lifecycle/rotation/restart tests 6/6, and focused packaging tests 15/15, including exact credential-free example distribution; final integrated results are recorded below |
| P2 | Webviews repeated JSON mechanics/Markdown; request-gate polling could outlive the owning view and optional read failures could stall independent panels; frontend types reached into backend classes | Shared JSON/Markdown mechanics, lifecycle-aware polling, separate poll completion revision and explicit frontend DTO/submission receipts; auth epochs and drafts remain app-owned | 54 new/focused and 48 existing UI checks passed; bounded browser review verified cached-view suspension, stale-response fencing, uncertain retry identity and shared Markdown at desktop/mobile widths |
| P2 | Current architecture/modes described disposable clones, read-only Factory, immutable worker identity settings, unimplemented Claude and all Git publication as future | Current guidance distinguishes leased mock/native Codex, local API/CLI tasks and shared Git publication; ADR retains original rationale and appends dated evolution | Guarded documentation review and strict vault checks passed with 0 errors and 0 warnings |
| P2 | Release packaging and publication did not require a reviewed version-specific change entry | Maintained `CHANGELOG.md`, version/tag validation and exact entry extraction; packaging archives the full changelog and stages a notes sidecar for publication | Current-version check and 56 release-focused tests passed; publication retains the existing six assets |

## Dependency and ownership result

The three deployable applications still communicate through authenticated APIs.
Factory owns hierarchy and new-intake delivery; the chosen orchestrator owns
accepted tasks, attempts and leases; the worker owns actual execution, local
journals and shared-intake publication. Shared contracts do not import an
application. A new interface is justified by a policy consumer or an independent
adapter, not simply by wrapping every existing method.

All worker application modules and the extracted orchestrator application
directory now depend inward on contracts and injected ports. The architecture
check includes type-only imports, so importing a concrete journal merely to infer
a return type cannot silently restore coupling. Node crypto/path/timer helpers
and YAML parsing are explicitly allowed in application policy. Protected modules
reject computed dependencies because their allowed graph must be statically
reviewable; composition roots can still select configured adapters dynamically.

The AST checker resolves repository-relative imports, explicit aliases,
`@werk/*`, absolute paths and file URLs. It is not a full JavaScript evaluator,
a dependency vulnerability scanner or a resolver for arbitrary package-export
conditions. Negative fixtures demonstrate actual rejections for the supported
forms and acceptance of legitimate composition. TypeScript checking remains a
separate required check.

The static audit of 162 backend TypeScript modules found no runtime cycle through
relative declaration imports. Type-level cycles remain around cohesive contracts
(domain/validation/gates, capabilities/Factory and interaction/model/conversation).
That limited scan does not prove absence of every dynamic runtime cycle. The
ports/DTO changes remove concrete provider and workspace type dependencies where
useful; flattening all type relationships would add churn without establishing a
better ownership boundary.

## Intentional separation and remaining work

| Item | Decision / follow-up acceptance |
| --- | --- |
| Independent distributions repeat shared modules and runtime dependencies | Preserve this payload duplication: a copied Factory/orchestrator/worker app must run without source, sibling apps or npm install. Artifact closure and copied-app tests are the right guard. |
| Lease snapshots, local run evidence, request gates and shared publication journals differ | Preserve their identities, schemas and transaction/recovery rules. Sharing private DB opening does not authorize merging workflow stores or equating local completion with leased completion/merge. |
| Host Git and immutable context Git have different trust | Preserve explicit profiles. Host operations need configured credential/SSH/proxy/CA settings; immutable reads must not consult ambient worktrees, config, filters or hooks. |
| MCP stdio and HTTP/SSE protocols differ | Keep their framing/session state machines, grant boundaries and safe errors separate. Shared bounded byte reading is the common mechanic; mutation retries remain explicit application decisions. |
| Runtime supervisors repeat portions of drain/stop logic | Defer a generic supervisor: native/system/Docker ownership and grace ordering differ. Extract only a proven shared lifecycle mechanic and retain process/restart regressions. |
| Large transactional Store, Workspace, Factory/orchestrator stores and legacy ChatPage remain | Concrete maintenance debt remains. Split one use case at a time with behavior/identity/draft/recovery tests; do not move state decisions into generic shared helpers. Legacy chat compatibility is preserved. |
| Repeated test setup | Git/temp fixtures, WorkerWorkspace setup and SnapshotJournal construction recur. Extract deterministic temporary Git/config/deadline/cleanup primitives after a second changed consumer needs them; keep scenario assertions and independent injected ports local. |
| Schema/validation duplication | `request-gates.schema.json` and TypeScript validation, WorkerCounts/overview validation, and parts of MCP task-source discoverability deserve focused parity/contract tests before consolidation. These are follow-up coverage opportunities, not proven admission bypasses. |
| Transport cancellation | HTTP handlers now own cancellation and await full handler settlement before database disposal; worker interaction forwarding checks cancellation after awaited I/O. Generic request ports still do not all expose caller `AbortSignal`; extend only with mutation-uncertainty and no-retry tests. Arbitrary uncancellable filesystem/adapters retain their existing completion waits. |
| Filesystem safety helpers vary by use case | Audit each source/destination authority and symlink/size/durability requirement before extracting another helper. A weaker generic file helper would be a regression. |
| Future delivery target | Mixed/concurrent live assignments, shared subscription quota, lease-fenced PR publication, independent project-check execution, Git webhook/merge tracking and high availability remain separate work. |

Numeric snapshot cursors and opaque task cursors intentionally serve different
ordering contracts. Provider connection IDs and orchestration provider enums
also express different concepts. Completion and abandonment validate different
state transitions. Their superficial similarity is not a reason to unify them.

## Runtime provenance and capability accuracy

Each distribution stages its own frozen release version from the root package.
Both ordinary dist and portable apps carry it; no runtime access to the source
checkout is needed. New snapshots and MCP initialization expose that version.
Old snapshot versions are not rewritten, and direct source execution says
`development`. The existing release manifest remains the authority for source
commit and file hashes; no timestamp or Git command was added to compilation.

Current docs now distinguish the implemented lanes:

- Orchestrator assignments are simulated by default. Native Linux Codex produces
  a retained worktree/validated review artifact and does not publish a PR.
- Local chat/approved-file tasks use configured API providers or supported
  Codex/Claude CLIs and operator-granted tools. Returned patches are reviewed;
  unknown measurements remain unknown.
- Shared Git intake freezes claimed source/checks, validates canonical done
  evidence and publishes a feature branch plus Obsidian review note. It preserves
  the developer checkout and uses the configured host Git authority. Human merge
  is still separate from task completion/publication.

## Additional configuration scope

All three portable apps now provide `env init`; project worker initialization
also creates the private project `.env`, credential-free `.env.example` and
ignore rules. One helper parses only the selected app's keys, preserves existing
content and adopts its selected saved credentials before generating missing
values. Relative environment state/config paths resolve from the project root.
The generated npm aliases include `env:init` and the project's
`worker:env:init`. Setup reports paths and added key names without token values.

Explicit CLI launch options override environment defaults, and process environment
overrides project dotenv. Saved worker connection and assignment settings retain
their existing authority. The root Factory/orchestrator component commands use
the same loader; the lower-level worker command and managed system deployment keep
their existing configuration boundaries. Docker project launchers load the mounted
project file and use `--env-file .env` for host-side port interpolation.

A stopped worker can intentionally rotate `WERK_WORKER_TOKEN` on restart without
losing identity/history; deleting the synchronized token file alone does not rotate
an environment-pinned token. Explicit remote `--url` calls require an explicit
token file or process credential and never infer one from local dotenv. Explicit
state-directory status/stop commands remain available for a malformed project file.

Secret-bearing files must be ordinary, stable UTF-8 files within the byte limit
and private on POSIX. Initialization can tighten an ordinary untracked file to
0600, but refuses tracked or linked secret writes. Reads do not repair permissions.
Unknown keys remain untouched, supported duplicate keys fail, and shell expressions
are literal. The runtime/package tests use local fixtures; no live credentials or
provider execution are implied. See [project environment configuration](../reference/configuration.md#project-environment-files)
for the exact supported keys, precedence and recovery contract.

## Release change record

The user also required a changelog for each release. The current entry starts at
0.8.0 without inventing historical entries. Maintainers curate Unreleased changes,
move completed changes into a dated version entry and run the changelog check
before tagging or packaging. Package/tag agreement, duplicate/empty entries,
placeholder markup and release-source output aliases have regression coverage.

Packaging validates before output, includes the full changelog in both runtime
archives and stages `RELEASE-NOTES.md` beside the candidate. Publication uses that
exact sidecar, then appends installation/qualification guidance. The existing six
published assets are unchanged. The [maintainer build contract](../reference/releases.md#maintainer-build-contract)
documents the commands and release-date convention.

## Qualification record

The initial coordinated run passed type checking and all builds, then reported
**1333 tests: 1318 passed, 5 failed and 10 skipped**. All five failures were
resolved. Three were build-fixture maintenance in this slice: the provenance
test assumed the wrong portable path, and two independent-build fixtures omitted
the new metadata generator. Corrected inputs retained the original assertions;
all **15 affected tests** passed. The coordinated rerun then passed type checking,
all three independent builds and portable packaging, followed by **1361 tests:
1351 passed, 0 failed and 10 skipped** in 103.6 seconds.

The following completed local checks supplement that combined-tree run:

| Check | Result and scope |
| --- | --- |
| Architecture, provenance and source Docker dependencies | 23 architecture/provenance tests plus 4 later source-context dependency tests passed. Missing/transitive-helper fixtures cover all three Docker copy lists; this is not a source-image build claim. |
| Git process boundaries | 10/10 passed on Linux, including actual helper/filter descendants, injected environments, promisor lazy-fetch and signature-program regressions. |
| Project environment | 15/15 helper tests, 6/6 portable lifecycle/rotation/restart journeys and 15/15 focused packaging tests passed. |
| Changelog, package and workflow | Current 0.8.0 entry check and the final independent 56/56 release-focused tests passed without skips. Generated workflow was synchronized from its canonical source. |
| Bounded webview review | Cached views stop polling, stale reads cannot update inactive details, uncertain retries retain identity, optional failures preserve independent refresh, and shared Markdown stays safe and usable at desktop/mobile widths. Saved captures were inspected. |
| Storybook | All 65 inventoried components, 104 stories and 208 desktop/mobile screenshots passed using local `/usr/bin/chromium`. The workflow's locked-browser run remains its own qualification authority. |
| Runtime archives | Packaging and verification/extraction of both archive formats passed. The extracted native smoke completed a simulated task, recorded both boundary snapshots and preserved state across restart. |
| Installed native project worker | Installation without npm, configurable feature folder, reviewed patch export, durable run evidence, revision-guarded question/replay and restart preservation passed with a provider protocol fixture. |
| Installed Docker project worker | Mounted feature intake, folder migration, restart without duplicate tasks, durable question/run evidence, watched repository pull, assigned worktrees and preservation of dirty developer checkout/worktrees across restart passed. |
| Documentation | Strict Forge vault checks passed with 0 errors and 0 warnings. |

These results qualify the reviewed local working tree and protocol fixtures. They
do not establish authenticated provider availability or live billable execution.
The corresponding GitHub platform jobs are authoritative for native Windows/macOS
behavior, including descendant cleanup; Linux results are not substituted for
those jobs. Tagged publication must pass the [candidate qualification gates](../reference/releases.md#candidate-qualification-gates)
against the exact candidate artifacts, including the locked-browser and VM gates.

## References

- [Current architecture](../explanation/architecture.md)
- [Execution modes](../explanation/modes.md)
- [ADR evolution](../explanation/adr-001-client-server-boundaries.md#evolution-recorded-2026-10-16)
- [Test suites and architecture checks](../../tests/README.md#architecture-checks)
- [Shared feature intake contract](../reference/shared-feature-intake.md)
- [Security boundaries](../reference/security.md)
