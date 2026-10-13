# Release journey: Forge tools and friction

Date: 2026-10-12. The installed CLI remains the latest published Forge v0.1.0. Improvements below are open upstream pull requests; none was merged or silently installed into this workspace.

## Tools used

Forge project selection, schema/help, guarded read/write/apply, link-aware move, backlog tracking/checks, vault strict validation, browser diagnostics and workflow projection supported this pass. Authored product edits and 27 documentation moves used previews and current revisions. Project selection stayed fixed while product agents edited concurrently; it changed briefly for the workspace README after source work finished.

Node/npm supplied compilation, behavioral checks and dependency audit. Docker supplied actual image, filesystem, isolation and lifecycle evidence. Python independently compared tar/ZIP payloads and checked VM extraction/readiness; systemd-analyze and the official cloud-init schema checked deployment artifacts. Git/GitHub tools were needed for isolated upstream branches, exact-head PRs and CI inspection. Browser checks used real services rather than fabricated success responses.

## Reproduced issues and dedicated upstream changes

| Finding | Improvement and evidence |
| --- | --- |
| Suffixed Dockerfile/Containerfile sources returned base64 and no text diff. A helper representation mistake was caught by a real Docker build and repaired through a guarded write. | [PR 23](https://github.com/Luis85/agent-cli/pull/23), head `9045e5595cbdf120993369408bcea162fe105c1f`, adds conventional nonempty suffix support, native-format precedence and invalid-UTF-8 fallback while preserving its tutorial fixes. Full check: 2,789 passed, 2 skipped; showcase 276 clean; four CI workflows successful. |
| Writing CLI output to a full device emitted a raw Node stack. Mutation could already have completed when output failed. | [PR 27](https://github.com/Luis85/agent-cli/pull/27), head `d708d7a688bdd1a426e2a30057e982de94950d6a`, adds bounded ENOSPC/EDQUOT/EIO diagnostics, preserved nonzero status and closed-pipe behavior, without false rollback claims. Seventeen focused checks and full check (2,744 passed, 2 skipped), showcase and vault passed. Four CI workflows successful. |
| UTF-8 `.ps1` files were opaque attachments, preventing normal guarded text edits and preview diffs. | [PR 28](https://github.com/Luis85/agent-cli/pull/28), head `a53702009c749e83aa5f39144424672326423561`, adds case-insensitive PowerShell text classification. BOM/CRLF are preserved; UTF-16 or invalid UTF-8 remains binary. No script execution or encoding conversion was added. Thirty-nine focused checks and full check (2,744 passed, 2 skipped), showcase 276, vault and diff checks passed. Latest observed CI: workflow-drift and developer-admin checks passed; main Forge and release workflows were still running, with no failures observed. |

The findings were recorded before dedicated improvement work began. `Dockerfile.release.dockerignore` already works with PR 23, so no duplicate fix was created. PR 27 initially had a Windows Node 24 fresh-install readiness timeout; rerunning only that failed job at the unchanged head succeeded. That transient result does not establish that all future readiness failures are harmless. Earlier PR 26 remains an independent metadata/source-contract improvement.

## Tools that would have helped

- An encoding-aware text-edit operation that returns current revisions and refuses accidental base64-as-text writes. Classification helps conventional filenames, but edit clients must still inspect the declared encoding.
- Bulk revision reads and explicit per-command project targeting, reducing custom batch assembly and shared-selection coordination between agents.
- A reviewed project verification manifest with isolated jobs, bounded runtime, sanitized output and artifact references for native compiler/tests, Docker, security audit and browser evidence.
- A release acceptance command combining manifest/archive integrity, extraction, lifecycle/restart checks and explicit platform results. A cloud-init/systemd validation adapter could similarly separate rendering checks from actual VM qualification.
- A Docker storage preflight that understands the active storage driver. VFS consumed far more physical space than image layer deltas suggested; owned temporary images/cache needed targeted cleanup. The slim, pinned offline runtime image reduced approximately 1.14 GB to 275 MB while retaining verified Git operations.

These remaining tools are proposals. They do not replace the product's native checks or authorize unrelated plugins, publication or destructive cleanup.

## Product evidence

The complete Werk check passed **400 tests with zero failures** and TypeScript validation; dependency audit found zero vulnerabilities. The [product review](journey-review.md) records exact extracted-release gates, browser evidence, infrastructure validation and honest platform/stateful/mock limits. The [Twelve-Factor audit](twelve-factor-audit.md) preserves architectural work still required before stateless replicas or HA.
