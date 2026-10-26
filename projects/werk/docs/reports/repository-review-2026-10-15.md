# Werk 0.4.0 repository review and polish

Reviewed on 2026-10-15, starting from released `v0.3.0` and the worker's new
multi-repository implementation. Six parallel reviews covered task authors,
worker operators, fleet administrators, maintainers, security and release
operations. Findings were reproduced before changing behavior; each lane then
verified its fixes, with a second review across the new routing boundaries.
A follow-up inventory identified concurrent [PR #10](https://github.com/Luis85/production-line/pull/10),
which adds native Windows Claude Code CLI support. It was reviewed in an isolated
checkout for integration into the main [PR #11](https://github.com/Luis85/production-line/pull/11),
alongside fixes prompted by the platform CI matrix.

## Acceptance

- Assign several existing Git repositories to one worker, observe independent
  fetch/fast-forward status, and keep coding tasks in retained worktrees inside
  the selected repository. Preserve dirty files, local commits and task bases.
- Preserve the repository selector from Factory intake to an eligible worker.
  Saved assignment changes must take effect without re-enrollment, and an
  in-flight assignment must not move to another checkout.
- Enforce readiness, completion, queue capacity, replay safety and graceful
  shutdown consistently across normal tasks, guarded execution and continuation.
- Make repository selection, file-task intake, rework results and onboarding
  usable on desktop and mobile, with keyboard access and retained drafts.
- Keep review artifacts verifiable, provider capabilities bounded, credentials
  private and deployment documentation consistent with the shipped runtime.
- Qualify the exact prebuilt release through the existing platform, Docker,
  VM and Storybook gates before publishing.
- Preserve Claude isolation flags, private prompt handling and credential
  boundaries on native Windows; supervise provider descendants through abort,
  timeout and parent exit. Keep Windows Codex CLI unavailable.
- Validate native Git registration paths and canonical temporary paths without
  relying on a runner's Git line-ending policy or installed provider CLIs.

## Findings and resulting behavior

| Priority | Perspective | Reproduced finding | Improvement |
| --- | --- | --- | --- |
| P1 | Task correctness | A successful snapshot with a blocked or non-final gate could be completed. | Completion requires passed final gate evidence when a gate is present; legacy ungated records remain compatible. Invalid gate enums are rejected. |
| P1 | Fleet routing | Pinned Factory dispatch dropped the requested repository, and workers could claim tasks for unassigned repositories. | Selector-preserving delivery, persistent worker repository capabilities, repository-aware claims and bounded Factory capacity observations. Explicit assignment IDs remain distinct from legacy fallback. |
| P1 | Concurrent operations | A repository could be remapped while a remote claim or assignment recovery was pending. | Repository changes are blocked through acquisition and local publication of accepted leases. |
| P1 | Recovery | A failed admission reused the same undispatched interaction ID and permanently prevented a later guarded execution. | Fresh guarded attempts recover the saved request while command receipts remain idempotent. Failures are recorded durably. |
| P1 | Resource limits | Guarded execution and saved answers bypassed local queue limits; asynchronous admission could hide a reserved slot. | Shared admission checks and visible reservations cover chat, file tasks and continuations. |
| P2 | Shutdown | New chat and continuation preparation could overlap shutdown. | Admission stops before teardown and pending preparation drains before evidence journals close. |
| P2 | Native execution security | Ignored provider files escaped the allowlist check in retained worktrees. | Ignored files participate in verification; unauthorized retained files cause rejection without deleting evidence. |
| P2 | Provider contracts | Unknown Codex item types could pass the no-tools conversation parser. | Only recognized no-tools event and item types are accepted; observation accounting is preserved. |
| P2 | Artifact integrity | Permissive UTF-8 decoding could make altered malformed bytes match an existing text digest. | Review verification rejects malformed UTF-8 and preserves valid BOM bytes before checking integrity. |
| P2 | Fleet intake UX | Choosing Live Codex in Factory left the provider set to Automatic, producing invalid requests. Repository IDs had no form input. | Live mode selects Codex; both intake forms accept assignment IDs and show the selected repository in task context. |
| P2 | Worker UX | Checkout paths were truncated, narrow gate tables clipped results, and file intake lacked a close/focus-return path. | Wrapping repository details, readable gate results, Close/Escape with draft retention and restored focus, clearer intake and queue labels. |
| P2 | Onboarding | Tours blocked the interface and mixed English controls into German fleet screens. | Nonmodal tours leave the page usable and use the surface's language while retaining Escape and focus recovery. |
| P1 | Deployment | Project-worker and source-worker Docker images lacked Git; lean release images lacked SSH; Git transport context was filtered from workers. | Git-capable pinned images, verified SSH runtime dependencies, and narrowly forwarded proxy/CA/SSH-agent context independent of provider credentials. |
| P2 | Documentation | Release documentation denied automatic updates; backup guidance omitted assigned repositories; the guide conflated project and repository. | Correct update instructions, explicit repository/worktree backup scope, accurate Worker/project explanations and scoped cookie-security guidance. |
| P1 | Windows provider lifecycle | PR #10's initial PID-tree cleanup could miss descendants after their provider parent exited, including children retaining output pipes. | A Job Object supervisor contains the provider before its code runs, terminates remaining descendants on normal exit and closes lifetime containment on cancellation. Native Windows qualification is required before merge. |
| P1 | Windows repository identity | Git reports registered worktrees with forward slashes, while native paths use backslashes. Raw comparison rejected a valid owned worktree. | Resolve absolute registration paths using native path semantics while retaining canonical-directory, ownership, base-commit and tamper checks. |
| P1 | Windows worktree paths | Full 100-character assignment IDs could exhaust Windows path limits in checkout and Git administration paths. | Bounded readable names include a digest of the complete assignment/task identity; ownership metadata retains the full ID and rejects mismatches. |
| P2 | Portable verification | macOS temporary-directory aliases, Git checkout line endings, POSIX path expectations and host CLI discovery made fixtures environment-dependent. | Canonical fixture roots, explicit Git line-ending settings, CRLF-safe component extraction, native path expectations and a paused API-provider fixture retain the original behavior assertions. |

The implementation retains the Factory/orchestrator/worker boundaries. Repository
capabilities use existing JSON persistence rather than a database migration and
do not change enrollment hashes. Missing entries in an advertised repository
capacity list fail closed, including truncated lists; older lines without the
extension retain their compatible behavior. Mock execution stays explicitly
simulated. Worktrees are retained for review; they are not automatically committed,
pushed or merged by the worker.

## Visual evidence

Desktop and mobile screenshots were captured from built applications and inspected
before polishing. The Worker review exercised unlock, empty taskboard, provider
setup, file intake, request rework and candidate acceptance, history, project
requests, assigned repositories and monitoring. The fleet review exercised Factory,
line intake, task and worker details, navigation and the system guide. Selected
before/after evidence:

| Journey | Before | After | Acceptance |
| --- | --- | --- | --- |
| Worker file intake, desktop interaction panel | [Before](../evidence/archive/2026-10-15-repository-review/worker-file-intake-desktop-before.png) | [After](../evidence/archive/2026-10-15-repository-review/worker-file-intake-desktop-after.png) | Full checkout path visible; Close/Escape retains the draft and restores trigger focus. |
| Worker request rework, mobile | [Before](../evidence/archive/2026-10-15-repository-review/worker-rework-mobile-before.png) | [After](../evidence/archive/2026-10-15-repository-review/worker-rework-mobile-after.png) | All four gate columns fit the 350px interaction panel; operator-review failure stays explicit. |
| Factory live intake, desktop | [Before](../evidence/archive/2026-10-15-repository-review/fleet-before-factory-live-desktop.png) | [After](../evidence/archive/2026-10-15-repository-review/fleet-after-factory-live-desktop.png) | Live Codex selects the compatible provider and exposes the repository assignment. |
| Line intake, mobile | [Before](../evidence/archive/2026-10-15-repository-review/fleet-before-line-intake-mobile.png) | [After](../evidence/archive/2026-10-15-repository-review/fleet-after-line-intake-mobile.png) | Repository choice appears in the form and preview without page overflow. |

## Verification

The following results qualify the initial `0.4.0` candidate at `9fc5094`, before
the portability fixes and PR #10 integration. The 1,010 passes plus one skip
are a baseline of 1,011 tests, not the integrated candidate's final count.
The archive and visual inventories likewise describe that earlier candidate.

- `npm run check`: TypeScript and Vue checks, all independent application builds,
  **1,010 passing tests**, zero failures and one platform skip (PowerShell installer
  restart guidance on Linux).
- Focused cross-review: 116 orchestrator/Factory cases, 45 security cases, four
  worker repository-routing cases and ten admission/recovery/shutdown cases.
  These overlap the full suite and are not additional totals.
- The final four-field HTML pattern correction was rebuilt and rechecked with
  24 focused UI tests and the browser journey. Invalid repository paths are
  rejected client-side using Chromium's current pattern semantics.
- Worker browser acceptance: ten journeys at desktop/mobile sizes, including
  keyboard focus and draft retention, with no page overflow or browser errors.
- Storybook: **58/58 source components, 86 stories and 172 desktop/mobile
  screenshots** qualified. Repository-assignment fixtures are included.
- Fresh runtime archives: 1,509 manifest inventory entries verified. Extracted
  native runtime and project-worker installation, simulated task evidence,
  interaction recovery and persistent restart passed without npm installation.
- Exact extracted candidate: project-worker, single-line and whole-system Docker
  journeys passed. Coverage includes watched Git pull, retained worktree,
  dirty-checkout preservation, review patch, restart, Git/SSH dependencies,
  independent line state and launchers without host Node.
- Dependency audit: zero vulnerabilities. Generated workflows match their
  project sources. Strict documentation validation has zero errors or warnings.

Release publication is additionally gated by GitHub Actions for the exact tagged
revision, including Windows/macOS/Linux, Docker and an actual Ubuntu cloud-init
VM. Configured workflow coverage alone is not evidence that those jobs passed.

## Concurrent PR and platform follow-up

PR #10 was reviewed across provider selection, Windows account environment,
Claude isolation arguments, private prompt-file cleanup, bounded status checks
and descendant process lifetime. Long protocol instructions use a private
system-prompt file rather than a command-line argument; provider tooling and
MCP access remain disabled. The integrated release retains version `0.4.0`;
PR #10's proposed `0.3.1` version is not a separate publication target.

Windows supervision uses kill-on-close Job Objects. The supervisor joins its
lifetime job before creating a suspended provider and assigns the child to
its execution job before resuming it. Normal provider exit terminates remaining
descendants before draining output. Cancellation terminates the supervisor,
closing the lifetime job without a PID lookup. Failure to establish containment
fails the invocation. Native Windows tests cover cancellation, parent exit with
inherited or ignored pipes, bounded status checks, argument quoting and raw stdin.
Native CI diagnostics located startup stalls in PowerShell `Add-Type` under the
restricted environment, before provider launch. A compiler matrix reproduced the
stall with restricted environments. A [focused native diagnostic](https://github.com/Luis85/production-line/actions/runs/38784001817)
then confirmed that preserving the host’s PowerShell module path allows the
actual helper to compile, restore the caller’s environment, contain the provider
and complete successfully; substituting a built-in-only module path stalled.
The supervisor receives a fixed allowlist of Windows installation/architecture
variables and the host’s module path. It restores the caller’s original values,
removing additions, before creating the provider. Raw-stream pumps start after
the suspended provider resumes. Native fixtures verify provider behavior and
environment restoration. A direct native child supplies the comparison baseline
for all eleven runtime keys, including values Windows adds during process startup.

A [second native diagnostic](https://github.com/Luis85/production-line/actions/runs/38790949779)
identified PowerShell progress diagnostics on stderr alongside valid Claude JSON
on stdout. Claude status now parses stdout independently, while both streams
remain subject to the shared output limit and deadline. Codex status retains its
stderr parsing. Regression coverage verifies authentication beside benign
diagnostics, oversized stderr rejection and private diagnostic redaction.

The platform follow-up distinguishes a production fix from fixture corrections:

- `bca5bff` fixes Windows worktree registration comparison. A regression also
  retargets Git administration metadata and confirms that reuse is rejected
  without losing retained task edits.
- macOS fixtures resolve temporary-directory aliases before comparing canonical
  repository identities. Disposable Git fixtures set `core.autocrlf=false`;
  component extraction normalizes CRLF. Production snapshot bytes and integrity
  checks are unchanged.
- Paused task-admission fixtures explicitly configure an API provider and assert
  that the task remains queued. They make no model request and require no host
  CLI installation. Path expectations use the current platform's native resolver.
- The shutdown regression advances only its configured deadline clock while
  retaining real TCP upload abortion, one database close and database reopening
  assertions; it does not depend on CI wall-clock scheduling.

| Evidence | Status and scope |
| --- | --- |
| PR #10 isolated Linux `npm run check` | 924 passes, zero failures, eight platform skips; 932 tests total. This is the separate PR #10 checkout, not the combined release. |
| Combined Linux check after repository and lifecycle corrections | 1,015 passes, zero failures and eight platform skips; 1,023 tests total. Windows-only startup and environment changes are qualified separately by native CI. |
| Main portability regression selection | 29 passes, zero failures or skips on Linux, including registration tampering and deterministic repository fixtures. |
| Native Windows Claude provider supervision | [PR #10 checks](https://github.com/Luis85/production-line/pull/10/checks) record the isolated branch’s qualification. The integrated code is checked again in PR #11; Linux skips do not establish Windows behavior. |
| Combined candidate platform matrix and release artifacts | [PR #11 checks](https://github.com/Luis85/production-line/pull/11/checks) record qualification for the integrated candidate. The [v0.4.0 release](https://github.com/Luis85/production-line/releases/tag/v0.4.0) publishes only after the tagged revision’s archive, Docker, cloud-init VM and Storybook gates pass. Earlier counts and archives above remain baseline evidence. |

## Qualification boundaries

Live-provider protocol tests use controlled CLI and HTTP fixtures; this pass did
not use an authenticated provider account. Browser and Storybook data are
simulation fixtures. Linux process-group cancellation is covered. Windows Job
Object supervision applies to provider invocations and provider-status checks;
it does not establish cancellation of Git descendant SSH/helper processes on
Windows, which remains outside this evidence. Native Windows evidence is
recorded in the linked CI checks. Native Codex worktree execution remains Linux-only, and
Codex CLI conversations remain unavailable on Windows. Repository worktrees
separate task edits but are not isolation for mutually untrusted tenants.

The concurrent PR inventory and its review are recorded above. The combined
increment is delivered through PR #11 and the normal `v0.4.0` release workflow,
preserving all existing qualification gates. Publication requires the final
revision's results, not the earlier candidate's successful checks.
