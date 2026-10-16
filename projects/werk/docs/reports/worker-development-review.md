# Worker software-development review

Date: 2026-10-16. Scope: local worker requests, shared Git intake, attached CLI/API models, tool grants and review handoff for 0.10.0. This extends the [worker experience review](worker-experience-review.md); older reports describe their own baseline.

## Finding

The attached models already support iterative coding. Werk's local approved-file workflow was the limiting layer: the model returned complete replacement files as final JSON, and the worker saved a patch without materializing it. An approved test command could therefore pass against the original worktree while the review artifact described different code. PR #26 adds useful project CLI access but does not by itself establish a verified implementation.

The separate native Codex assignment adapter already edits a worktree, but it has different platform, authorization and orchestration contracts. Routing local requests into it would bypass the local provider/tool policies and exclude other attached providers. The chosen increment extends the existing shared tool broker instead.

## Acceptance criteria

- A newly accepted repository request with explicit approved paths and configured required checks can inspect code, create/change/delete approved text files, run real checks, observe failure, repair and check again.
- Source changes occur in the worker-owned, commit-pinned worktree. The developer's checkout stays unchanged.
- Every required check must pass on the final candidate. The worker derives the patch from actual files; a model sentence cannot supply verification evidence.
- Edits invalidate earlier verification. Unapproved changes, stale hashes, replaced worktrees, failed checks, revoked grants, cancellation and interrupted persistence must not yield a false verified result.
- Progress, blockers and check results remain inspectable in the worker and its Markdown feature record. Shared intake publishes the same approved patch and review evidence, keeping merge approval with humans.
- Existing saved proposal tasks retain their accepted contract. No migration silently adds write authority.

## Primary-source research

All linked sources were retrieved on 2026-10-16. Provider documents change independently of Werk; the installed executable and observable protocol remain part of qualification.

| Source | Finding | Consequence for Werk |
| --- | --- | --- |
| [OpenAI non-interactive Codex](https://learn.chatgpt.com/docs/non-interactive-mode) | `codex exec` supports explicit sandbox policy, structured events, saved CLI authentication and structured final results. Current documentation removes `--full-auto`. | Preserve stock CLI authentication, explicit permissions and version-aware integration. Native coding ability does not make every wrapper a coding agent. |
| [OpenAI TypeScript SDK](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) | The SDK wraps the Codex CLI, provides continuing threads and streamed tool/file events. | A new SDK is not necessary to add Werk-owned tools; native session persistence would be a separate product decision. |
| [OpenAI App Server](https://learn.chatgpt.com/docs/app-server) | A persistent client can initialize a connection, start/resume threads and receive execution events. Dynamic tools are an experimental capability. | Potential future streaming integration; adopting it now would broaden transport and recovery changes without fixing artifact verification by itself. |
| [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling) | The application executes requested functions and returns their results for further model turns. | Existing API adapters can use the same candidate operations as CLI providers. Repair belongs inside this bounded tool loop. |
| [Claude headless CLI](https://code.claude.com/docs/en/headless) and [CLI reference](https://code.claude.com/docs/en/cli-reference) | Headless execution retains an agentic tool loop. Native tools, MCP inventory, settings and session persistence have separate controls. `--bare` omits subscription OAuth/keychain authentication. | Keep the existing authenticated stock CLI and explicit Werk MCP bridge; do not replace isolation flags with `--bare` blindly. |
| [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) and [permissions](https://code.claude.com/docs/en/agent-sdk/permissions) | The SDK supplies coding tools and context handling; automatic approval lists are not a complete authority boundary. | Retain application-side tool authorization. SDK migration is optional, not a prerequisite for feature implementation. |
| [Claude legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) | The documented boundary allows end users to authenticate the unmodified Claude Code binary with their own subscription; credential intermediation is different. | Preserve native authentication. Werk neither extracts subscription credentials nor moves them into an API/SDK integration. |
| [Claude best practices](https://code.claude.com/docs/en/best-practices) and [long-running harness research](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | Concrete acceptance tests, incremental work and durable progress reduce premature completion; end-to-end checks catch failures missed by narrow unit tests. | A finished response is insufficient. Persist candidate/check evidence and ask project owners to supply meaningful acceptance checks. |
| [Claude sessions](https://code.claude.com/docs/en/agent-sdk/sessions) | Conversation continuation does not itself restore filesystem state. | Retain Werk-owned worktree identity, accepted scope and durable checkpoints independently of native session IDs. |
| [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [Claude environment variables](https://code.claude.com/docs/en/env-vars) and [Claude MCP](https://code.claude.com/docs/en/mcp) | Provider MCP deadlines differ from application deadlines. Claude uses milliseconds for `MCP_TOOL_TIMEOUT`; per-server timeout overrides it and, from 2.1.203, values of at least 1,000 ms also raise the idle timeout floor. `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` disables automatic backgrounding. | Derive bridge waits from the trusted accepted invocation duration. Retain both Claude timeout settings so a long command is not cut off by the stdio idle default, and explicitly disable backgrounding. These documented settings are not a live Claude qualification. |
| [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | Tool definitions and results support model invocation; annotations are not trustworthy authority by default. | Discovery does not grant access. Tool results cannot widen approved paths or replace completion evidence. |
| [Git worktrees](https://git-scm.com/docs/git-worktree) | Linked worktrees have separate working files, HEAD and index, while repository metadata is shared. | Worktrees isolate candidate files; they are not OS sandboxes. Verify ownership/base and keep arbitrary commands explicitly granted. |

The implementation choices below are engineering conclusions from this research and the repository audit, not claims that a provider guarantees correct software.

## Product and architecture decisions

| Perspective | Decision |
| --- | --- |
| Operator experience | Keep one request composer. Approved repository files remain optional. Explain whether a new request can implement and verify or will produce a proposal; never infer a saved task's mode from current settings. |
| Development workflow | New eligible requests freeze approved paths and every enabled command preset marked as a required feature check. Candidate tools provide inspect/apply/check/repair, including explicitly approved new files and deletion. |
| Artifact integrity | Generate review changes from the actual candidate. Bind verification to candidate digest and frozen check fingerprints. Later edits require fresh checks. |
| Provider reuse | Reuse Codex CLI, Claude CLI, OpenAI API and Anthropic API adapters and their common granted-tool protocol. Native provider shell/edit tools remain disabled for this local workflow. |
| Reliability | Preserve scope, candidate/check receipts and accepted context. Interrupted attempts retain work and require explicit continuation; unknown persistence cannot become success. |
| Capacity and cost | Keep one worker execution slot, serialized side effects, cancellation/drain and consumption admission. Retain the default 128 calls, 300-second command ceiling and six-hour duration. Optional command/CLI/check timeouts are capped by that frozen ceiling; MCP deadlines are independent and all calls remain bounded by the invocation. No separate tool window is introduced. |
| Security | Per-request approved paths and a saved file grant jointly authorize candidate edits. Required commands retain their exact operator-configured executable/arguments. CLI and MCP commands still run with their configured host authority. |
| Team review | Generated Markdown explains progress and verification. Shared intake retains configurable ready/done rules, a feature branch and a human review note. A passing command is not a merge approval. |
| Maintenance | Put filesystem/Git/process effects in infrastructure behind an application port. Keep provider transport independent of candidate policy and reuse public evidence projection in UI and notes. |

## Verification facts

`output.verificationPassed`, `output.requiredCheckCount` and `output.candidateDigest` come from worker-observed candidate/check evidence, and participate in the saved result digest. They remain unknown for legacy proposal tasks. Generic required commands are not automatically classified as unit tests or builds; `tests.passed` and `build.passed` are not fabricated from a model's prose.

An implementation result with explicitly failed or missing required verification is held for rework even if a custom done policy omits that rule. A team that also requires actual implementation for proposal-only requests can add `output.verificationPassed == true` to `fr-done-check.json`. This holds a proposal-only result rather than falsely accepting it as tested code.

## Qualification record

Independent reviews exercised real Git worktrees and real child-process checks with deterministic model/tool fixtures. They found and corrected a generic-command path that retained a stale passing receipt, a custom done-policy path that mislabeled unverified work, and the native CLI bridge's hidden five-minute HTTP timeout. The resulting workflow covers edit/check/fail/repair, changed-candidate invalidation, durable recovery, cancellation, revoked grants, approved deletion and shared publication without merging the developer checkout.

The earlier feature-development browser confirmation passed 11 interaction checks across 30 screenshots at 1440, 390 and 320 pixels, with no page errors or horizontal overflow. It covers saved evidence, stale/failed checks, retained disclosure and follow-up drafts during polling, exact patch download, required-check setup and concurrent/environment-controlled budget editing. Receipts in these screenshots are explicitly illustrative fixtures. PR #29's supplied readable-reply PNGs also predate integration. Neither set alone qualifies the final combined PR #29/#30 UI; the current browser evidence is recorded separately on PR #25.

A live preflight used installed stock Codex CLI 0.159.2, which reported ChatGPT sign-in. The worker adapter did not receive an accepted response before its 120-second deadline. A bounded diagnostic reported connection, WebSocket and authentication-refresh failures. This environment therefore did **not** qualify live model implementation; no successful commercial-model run is claimed. Claude CLI was not installed.

PRs #24, #26, #27, #28, #29 and #30 are incorporated into the open integration branch with preserved ancestry. Full integrated test/Storybook results and cross-platform CI are recorded on PR #25. The user paused merge and release while another session is active; this report does not imply publication. A protocol fixture proves harness behavior, not a commercial model's feature quality or every provider/version combination.

## Remaining boundaries

This increment supports bounded text-file features: 32 explicit approved paths, 24,000 bytes per initial file and 48,000 initial characters total. Edited approved content is limited to 48,000 bytes total and the review patch to 120,000 bytes. Binary edits, secret-like paths, dotfiles, unconstrained repository-wide refactors and implicit scope expansion remain outside this path. Choose a smaller feature or explicitly prepare a new approved request when the work needs additional paths.

The source snapshot is limited to 20,000 files and 64 MiB, with 8 MiB per unapproved file. Symlinks, hard-linked source files, submodules, sparse and assume-unchanged index entries anywhere in the inspected source set currently block implementation. Ignored build/dependency outputs are excluded. These are explicit conservative support limits, not claims that all software repositories are supported.

Verification quality depends on the configured project checks. Check scripts can be incomplete, flaky or malicious; a zero exit status records their observed result, not a universal correctness guarantee. Runtime packages, dependencies, network services and ignored build outputs are environment inputs, and must be prepared and reviewed for the project. Worktrees do not confine approved commands to a filesystem sandbox.

Token streaming, native provider session resumption, automatic context compaction for API adapters and visual browser acceptance infrastructure remain separate follow-ups. None is necessary to establish an honest bounded implementation/check/repair loop. Model errors, timeouts and consumption limits still require an explicit continuation when the invocation cannot finish.
