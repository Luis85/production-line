# Subscription-backed worker interactions

Research checked against official primary sources on 2026-10-14. This report
separates documented provider capabilities from Werk implementation and proposed
future adapters. No subscription credential extraction or live inference was used.

## Current decision

Keep the operator's configured, unmodified Codex or Claude CLI and the existing
no-tools/read-only lane. The unified application interface prepares and retains
semantic context before execution, validates an explicit Werk question/escalation
protocol, and reports truthful `worker_context_replay` continuation. Native
provider resume and text streaming remain unsupported by this implementation.
A subscription is not an API key, a successful login check is not a model/quota
check, and token telemetry does not establish a billed USD amount.

## Supported paths and limits

| Path | Authentication and integration | Interaction and accounting | Werk decision |
| --- | --- | --- | --- |
| Codex CLI | The published CLI reuses saved operator authentication. Machine-readable `exec --json` and explicit session-ID resume are documented. | JSONL lifecycle/item events and completed-turn token usage; native resume requires persistent provider history. | Implemented: ephemeral subprocess and worker-owned context replay; no native hidden session. |
| Codex TypeScript SDK | Official library wraps local Codex threads; use the supported local authentication rather than scraping credentials. | Thread continuation/resume, streamed events and structured output are available. | Future alternative; additional dependency/version/packaging qualification required. |
| Codex app-server | Supported stdio JSON-RPC handshake, thread/turn APIs; separate native account flow or registered Sign in with ChatGPT plan adapter. | Deltas, terminal status, interruption, token updates and local thread resume. Some question/tool APIs are experimental. | Strongest future subscription interface; keep tools disabled and generated schemas pinned to CLI version. |
| Sign in with ChatGPT Responses route | Explicit registered OAuth authorization; participating open-source/approved clients and eligible accounts. | Mandatory stream requests and a restricted request contract; HTTP context is supplied each call. | Viable separate future thin adapter; current API-key request body cannot be reused unchanged. |
| Claude Code CLI | End user can sign in through the unmodified binary with their own subscription, subject to the relevant terms. | Print JSON/streaming modes and native session resume exist; invocation cost is a client estimate, not billing. | Implemented: no-session-persistence, no built-in tools, strict empty MCP and isolated customization settings. |
| Claude Agent SDK | Official agent integration; API/cloud credentials are the documented product quickstart. Subscription availability and developer credential restrictions must both be respected. | Session resume, streamed SDK messages, user-input callbacks and permissions. Native user-input tools expand the current tool surface. | Future backend option; preserve no-tools policy and use verified authentication rather than custom subscription-token routing. |
| Gemini CLI | Official Google sign-in supports individual accounts including Google AI Pro/Ultra; cached authentication can be reused headlessly. API key/Vertex are separate routes. | JSON/JSONL output, session IDs/resume, usage/latency statistics; quota depends on authentication. | Relevant future provider; no Gemini adapter or no-tools qualification is implemented in Werk. |

Codex facts are supported by [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[the official SDK](https://learn.chatgpt.com/docs/codex-sdk), and
[app-server](https://learn.chatgpt.com/docs/app-server). Native thread features in
those products do not establish that Werk currently exposes them.

Claude SDK sessions and streamed outputs are documented in
[session management](https://code.claude.com/docs/en/agent-sdk/sessions) and
[streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output).
Gemini documents [authentication](https://geminicli.com/docs/get-started/authentication/),
[headless JSON and JSONL events](https://geminicli.com/docs/cli/headless/),
[session retention/resume](https://geminicli.com/docs/cli/session-management/) and
[authentication-dependent quotas](https://geminicli.com/docs/resources/quota-and-pricing/).
Gemini auto-saves provider history and has its own retention policy; neither
subscription inference costs nor no-tools isolation should be inferred from its
availability.

## Current subscription authorization nuances

OpenAI now documents eligible Plus/Pro plan usage in participating apps, available
to open-source partners and selected private clients. Identity-only sign-in does
not grant inference access; separate authorization scopes are required.
[Sign in with ChatGPT quickstart](https://developers.openai.com/siwc/quickstart).

The plan preview requires HTTP `store:false`, `stream:true` and array input;
`max_output_tokens`, background mode, Conversations and HTTP
`previous_response_id` are unsupported. WebSocket lineage is connection-local,
not persistent provider storage. App-server may retain local threads and resume
them while upstream requests use `store:false`. A dedicated adapter can therefore
support this route later, provided registration, scopes, token renewal and request
limits are implemented; inserting a subscription token into Werk's current
nonstreaming API-key transport is not that integration.
[Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

OpenAI's documented app-server setup passes the application's authorized access
token to the child, sets provider configuration, initializes client identity and
handles renewal by restarting and resuming the saved thread. Its model catalog
is explicitly not an entitlement check.
[Plan-backed app-server setup](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).

Anthropic's October 7 update says Agent SDK, `claude -p` and third-party app usage
can still use subscription limits; Max/Team also include monthly API credits.
[Current subscription support notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

This does not authorize arbitrary credential intermediaries. Current legal docs
permit an end user to sign into an unmodified Claude Code binary with their own
subscription, including on a platform running the published binary under the
stated terms. Developers must not offer their own Claude.ai login, collect or
intermediate session tokens, route consumer credentials on users' behalf, modify
the binary, or resell/intermediate inference. API/cloud credentials remain the
recommended product integration. Operator-owned binary sign-in and a custom
OAuth/token gateway are different paths.
[Claude Code legal and credential conditions](https://code.claude.com/docs/en/legal-and-compliance),
[Agent SDK overview and terms](https://code.claude.com/docs/en/agent-sdk/overview).

Codex and Gemini source repositories use Apache 2.0. Source licensing does not
grant inference service access or supersede account/provider terms.
[Codex license](https://github.com/openai/codex/blob/main/LICENSE),
[Gemini license](https://github.com/google-gemini/gemini-cli/blob/main/LICENSE),
[Gemini authentication-specific terms](https://geminicli.com/docs/resources/tos-privacy/).

## No-tools execution and version preflight

Claude `--restricted` requires version 2.1.248 or newer. Keep it together with
`--safe-mode`, `--tools ""`, strict empty MCP configuration and disabled provider
session persistence. Removing isolation flags to accommodate an older CLI would
change worker authority. The saved-connection check can report a known unsupported
version and upgrade guidance without an inference request; an unknown version is
not confirmed compatible. Execution retains the required flags and fails closed.
[Official Claude CLI reference](https://code.claude.com/docs/en/cli-reference).

Codex retains its ephemeral/read-only sandbox, never-approval configuration,
disabled command/browser/app/multi-agent capabilities and isolated workspace.
Future app-server/SDK integration must preserve those effective restrictions;
protocol access to shell/process APIs is not permission to invoke them.

## Unified events proposal

Keep worker-owned, versioned events correlated by session, turn, run, revision and
monotonic sequence. The current durable lifecycle is `accepted`, `prepared`,
`started`, `usage_observed`, `input_requested`, `escalated`, `completed`, `failed`,
`cancelled`, `interrupted` and `pending_cancelled`. The built-in frontend currently polls the interaction view and private turn,
with numeric evidence in History. External applications and agents can consume
the durable worker event contract; a future frontend event consumer remains
optional. Neither surface depends on raw vendor payloads.

Tighten payloads as discriminated variants: a usage event requires usage,
a failure requires a safe classified code, and an input request carries a stable
pending-interaction correlation. Terminal events must correspond to committed
worker state. Poll/reconnect reads events after the last retained sequence; it
does not reinvoke the model. Duplicate input answers use existing operation-ID
admission guards.

Current adapters produce terminal results and available usage; they must not
manufacture live text deltas. Future streaming adapters can translate Codex
agent-message deltas, Claude SDK/CLI message deltas or Gemini message chunks into
a capability-gated `text_delta` variant. Vendor IDs and raw events remain private
adapter details. Native resume becomes a separately declared capability only
after its persistence and interruption behavior is qualified. Tool events must
be declined under the present no-tools policy.

These event mappings and future adapter priorities are design recommendations;
they do not claim new vendor backends, consumer OAuth setup or provider-native
resume have been implemented.


## Project discovery and long execution follow-up (2026-10-14)

Official [Claude skills](https://code.claude.com/docs/en/skills) recognize `.claude/skills/werk-worker/SKILL.md`. Current [Codex skills](https://developers.openai.com/codex/skills) recognize repository `.agents/skills/werk-worker/SKILL.md`; `.codex/skills` is not the documented current discovery path. The approved integration therefore uses those two recognized skills and a `.codex/werk-worker.md` companion explicitly read by the Codex skill. It does not imply that the companion alone is automatically loaded. These are instructions for an external project agent to inspect the worker CLI schema/capabilities, submit approved features, review results, answer pending questions with revision and stable operation IDs, and consume durable events. They do not grant tools to the worker's restricted model lane.

Preserve unmanaged files and report conflicts rather than overwriting project configuration. Do not inject `allowed-tools`, hooks, MCP, credentials or trust changes. [Claude memory](https://code.claude.com/docs/en/memory) documents that introducing CLAUDE.md can change existing AGENTS.md discovery; creating it is unnecessary here. [Codex configuration](https://developers.openai.com/codex/config-basic) loads project `.codex/config.toml` only for trusted projects, and [advanced configuration](https://developers.openai.com/codex/config-advanced) now uses user profile files rather than project `[profiles]` injection. This supports a recognized skill plus explicit companion, rather than changing existing configuration precedence.

The local execution policy is six hours per invocation by default, configurable from one second to 24 hours. Its effective limit is captured in each prepared dispatch; changing settings does not extend a running call. Explicit answer or resume creates another attempt with a newly captured execution budget. Waiting for operator input releases the execution permit and is not timed as model execution. Older durable dispatches without a recorded budget use the default. This is a bounded attempt policy, not a promise that a provider supports an uninterrupted 24-hour response or a total conversation duration limit. No automatic paid retry is introduced.

[Claude CLI](https://code.claude.com/docs/en/cli-reference) has no default `--max-turns` limit; the current no-tools wrapper retains provider response and output bounds. Its terminal-only output does not justify detecting a hang from silence. [Node AbortSignal](https://nodejs.org/docs/latest-v24.x/api/globals.html#static-method-abortsignaltimeoutdelay) supports caller deadlines, but [Undici Client](https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md) separately defaults headers/body inactivity deadlines to 300 seconds. Long direct API calls therefore also require a transport with those shorter deadlines disabled while retaining the frozen caller deadline. The provider-scoped transport disables headers/body deadlines and disposes its connection pool after each invocation. The initial connection timeout remains ten seconds; it does not cap an established model response. Local delayed-response and cancellation fixtures qualify this behavior, not real hours-long paid provider execution. Cancellation aborts local work; it does not prove remote provider billing or execution stopped.

For resource alerts, [Node 24 availableMemory](https://nodejs.org/docs/latest-v24.x/api/process.html#processavailablememory) reports free bytes still available to the process. [constrainedMemory](https://nodejs.org/docs/latest-v24.x/api/process.html#processconstrainedmemory) reports the OS-imposed capacity or zero when absent/unknown. Neither measures the worker's children. CPU deltas from [cpuUsage](https://nodejs.org/docs/latest-v24.x/api/process.html#processcpuusagepreviousvalue) measure the Node process only and can exceed elapsed time across cores. Resource warnings should retain those scopes and avoid describing elapsed time or absent streamed output as evidence of a stuck model.
