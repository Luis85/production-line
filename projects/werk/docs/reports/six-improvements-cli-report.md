# Six improvements: Forge tool report

Date: 2026-10-12 UTC. Installed Forge: published v0.1.0.

## Tools used

Parallel agents kept the selected Werk project fixed. Forge supplied project
inspection, schema/help, revision reads, reviewed dry-run/apply batches, strict
vault validation and generated-workflow synchronization. Node/npm supplied
compilation, behavioral tests and dependency audit; real browsers checked the
running product at 1440, 390 and 320 pixels. Docker ran the actual Caddy TLS
fixture and release journey. Git/GitHub provide publication and platform/VM CI.

## Friction and desired improvements

| Observation | Useful CLI improvement |
| --- | --- |
| Parallel validation needs isolated build outputs; rebuilding shared dist while another agent tests it is unsafe. | An opt-in verification manifest that describes reviewed commands and isolated working/output directories, with bounded execution and structured results. Do not infer permission to execute commands from untrusted document content. |
| We manually assembled acceptance reports from command logs, screenshots, source revisions and hashes. | An evidence manifest validator linking acceptance items to exact revisions, platform, exit status and artifact digests. It must distinguish planned jobs from executed results. |
| Project selection remains shared process-independent state. | Explicit per-command project targeting and batch revision reads; earlier upstream proposals cover these concerns. |
| Release qualification spans native platforms, Docker and a real cloud-init guest. | A qualification matrix reader showing passed, failed, blocked and not-run distinctly, without treating a valid cloud-init render as a booted VM. |
| PowerShell and suffixed Dockerfiles require encoding-aware clients in installed v0.1.0. | Apply the existing reviewed upstream text-classification fixes rather than creating duplicate PRs. Clients must still honor read encoding. |
| Codex login succeeded but execution transport returned HTTP 403. | A secret-safe provider diagnostic reporting endpoint hostname, HTTP status, retry category and credential presence separately, never raw tokens or unreviewed provider output. This belongs in Werk/provider integration rather than generic Forge file operations. |

No newly observed Forge data-loss or mutation failure required an emergency
patch. The existing dedicated upstream changes remain [PR 23](https://github.com/Luis85/agent-cli/pull/23),
[PR 27](https://github.com/Luis85/agent-cli/pull/27) and
[PR 28](https://github.com/Luis85/agent-cli/pull/28); their original evidence and
scope are in the [preceding CLI report](journey-cli-report.md). This pass did not
silently install or merge them. New verification/evidence commands are proposals,
not claims of implemented functionality.

See the [product review](six-improvements-review.md) for behavioral evidence and
remaining product boundaries.
