# Werk 0.4.0 repository review and polish

Reviewed on 2026-10-15, starting from released `v0.3.0` and the worker's new
multi-repository implementation. Six parallel reviews covered task authors,
worker operators, fleet administrators, maintainers, security and release
operations. Findings were reproduced before changing behavior; each lane then
verified its fixes, with a second review across the new routing boundaries.

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
| Worker file intake, desktop interaction panel | [Before](../evidence/2026-10-15-repository-review/worker-file-intake-desktop-before.png) | [After](../evidence/2026-10-15-repository-review/worker-file-intake-desktop-after.png) | Full checkout path visible; Close/Escape retains the draft and restores trigger focus. |
| Worker request rework, mobile | [Before](../evidence/2026-10-15-repository-review/worker-rework-mobile-before.png) | [After](../evidence/2026-10-15-repository-review/worker-rework-mobile-after.png) | All four gate columns fit the 350px interaction panel; operator-review failure stays explicit. |
| Factory live intake, desktop | [Before](../evidence/2026-10-15-repository-review/fleet-before-factory-live-desktop.png) | [After](../evidence/2026-10-15-repository-review/fleet-after-factory-live-desktop.png) | Live Codex selects the compatible provider and exposes the repository assignment. |
| Line intake, mobile | [Before](../evidence/2026-10-15-repository-review/fleet-before-line-intake-mobile.png) | [After](../evidence/2026-10-15-repository-review/fleet-after-line-intake-mobile.png) | Repository choice appears in the form and preview without page overflow. |

## Verification

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

## Qualification boundaries

Live-provider protocol tests use controlled CLI and HTTP fixtures; this pass did
not use an authenticated provider account. Browser and Storybook data are
simulation fixtures. Linux process-group cancellation is covered; termination of
Git descendant SSH/helper processes on Windows is not established by these tests.
Native Codex execution remains Linux-only. Repository worktrees separate task
edits but are not isolation for mutually untrusted tenants.

The initial remote PR inventory was empty. This increment is delivered through
its own reviewed pull request and the normal `v0.4.0` release workflow, preserving
all existing qualification gates.
