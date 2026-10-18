# Durable Feature Request sessions and delegation

Review date: 2026-10-18. This report records the research and architectural
choices for the worker increment after 0.12.0. The
[model interaction reference](../reference/model-interaction.md) describes the
implemented contract; this report explains why it was selected.

## Product requirement

A team designs requests during the day, commits and pushes ready requests in the
evening, then reviews implementation notes or answers blocking Task notes in the
morning. Each Feature Request owns one durable logical model session. Project
knowledge is shared explicitly; conversations, execution authority and results
remain attached to their request. A model may delegate part of that work when
its adapter and the operator's grant permit it.

A long-lived session does not require a continuously running model process.
Waiting for a person releases execution capacity. Restarting the worker must
preserve known state without replaying an invocation whose outcome is uncertain.
The [overnight guide](../how-to/shared-feature-intake.md#work-during-the-day-implement-overnight)
sets out the operational prerequisites and human review boundary.

## Primary-source comparison

| Integration | Useful capability | Decision for Werk |
| --- | --- | --- |
| [Codex SDK](https://developers.openai.com/codex/sdk/) | Typed programmatic threads and explicit thread resumption | Useful candidate for a future adapter; session convenience alone does not establish Werk's tool boundary. |
| [Codex app-server](https://developers.openai.com/codex/app-server/) | Persistent threads, progress events, compaction and account operations | Keep behind a future qualified adapter. It does not provide the same configuration isolation as the existing exec invocation, and rejecting an event after an action is not access control. |
| [Claude Code headless CLI](https://code.claude.com/docs/en/headless) and [session management](https://code.claude.com/docs/en/agent-sdk/sessions) | Explicit session identifiers and resumption through the published local binary | Use an exact private session identity per request. Never resume the most recent ambient conversation. Preserve current tool grants on every turn. |
| Direct OpenAI and Anthropic APIs | Explicit request history and function-tool exchange | Retain adapters behind the same contract. Durable worker checkpoints provide continuity without claiming native CLI memory. |
| [Agent Client Protocol v1](https://agentclientprotocol.com/protocol/v1/overview) | Version negotiation, session lifecycle, progress, cancellation and optional permissions/filesystem/terminal methods | Borrow the explicit lifecycle and capability model. Do not replace the existing worker contract or assume every ACP agent enforces all Werk permissions. The documentation labels v2 as a draft at the review date. |
| [Model Context Protocol](https://modelcontextprotocol.io/docs/learn/architecture) | Portable tool and context connections | Continue using MCP for granted tools, including the worker's private CLI bridge. MCP does not replace the model-session lifecycle. |

The common abstraction belongs in the worker application layer: accepted request,
logical session binding, context checkpoint, typed result, normalized usage and
cancellation. Provider-specific process flags, native session handles, wire
messages and credential discovery belong in adapters. Avoid a second intake,
request state machine or execution queue for each provider.

## Session and context decisions

Separate four identities: the Feature Request, its logical model session, an
interaction turn and an execution run. A native provider session is another
private handle bound to that logical session. A provider switch or incompatible
binding must not accidentally inherit another request's native transcript.

Persist intent before contacting the provider and await checkpoint writes. A
native handle is not proof that an interrupted turn finished. Reconcile a known
saved result without another call; an uncertain invocation requires explicit
recovery. Preserve a queued dispatch automatically only when all retained
authorities agree it never started.

The contract distinguishes native continuation from worker context replay.
Claude can resume its explicitly bound session through the stock CLI. Codex
keeps the existing isolated exec path and worker replay in this increment:
app-server exploration did not establish an equivalent complete tool boundary.
API adapters also use worker replay. None of these labels promises exactly-once
provider execution or restoration of hidden reasoning.

Bound active replay without erasing accepted scope or the latest question and
answer. An explicit archive checkpoint points to retained private history through
a read-only history tool. This is deterministic context selection, not an LLM
summary. Older decisions remain retrievable; a bounded UI transcript is not the
authoritative history.

Shared project context is opt-in through a committed `.werk/model-context.json`
manifest. Read its allowlisted files at the accepted source commit and record
content hashes. This gives requests the same reviewed project context without
mixing their conversations or silently importing the machine's ambient CLI
memory. Repository documents and tool results remain data, not permission grants.

## Delegation decisions

[Claude's subagent documentation](https://code.claude.com/docs/en/agent-sdk/subagents)
describes separate contexts and configurable tools. Native providers differ in
how they inherit permissions, limit depth and report child usage. Enabling every
native agent feature would bypass guarantees already owned by Werk.

Use a worker-owned delegation tool instead. The parent model decides when to
request child work; the operator grants the capability and bounds total children
and concurrent children. A child belongs to the same Feature Request and uses the
same accepted provider, model and execution profile. It receives scoped work and
borrowed access to the parent's current tool runtime. It cannot recursively
spawn another child or increase the parent's deadline, call allowance or grants.

Keep mutations serialized through the existing tool runtime while allowing the
delegation operation to await its children without holding that mutation queue.
Cancellation and revocation apply to the whole invocation. Record child execution
and consumption separately with parent linkage; do not count the same usage in
both parent and child rows. Child output cannot expand approved repository scope
or replace required verification receipts.

## API and subscription accounts

[Codex authentication](https://developers.openai.com/codex/auth) documents both
ChatGPT sign-in and API-key use. The local CLI owns subscription authentication;
Werk uses configured API credentials only through its API adapters. An account
label, a plan name and observed invocation usage do not reveal a reliable shared
subscription balance.

[Claude authentication](https://code.claude.com/docs/en/authentication) and
[its published credential rules](https://code.claude.com/docs/en/legal-and-compliance)
distinguish end users signing into the unmodified Claude Code binary from a
third-party application collecting or proxying subscription tokens. Werk's
subscription path uses the user's installed stock CLI and its own sign-in flow.
It does not extract CLI credentials to call an API or provide a substitute
Claude-account login. Environment credentials can affect which account is used;
the worker should report observed authentication without exposing secrets.

Provider versions can change usage semantics. The
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference) documents
`--system-prompt-snapshot off` from 2.1.257, needed to refresh accepted instructions
and budgets on native continuation. The
[cost-tracking reference](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
explains how resumed cost reports changed between per-invocation and cumulative
session totals.
Normalize only when the report's scope is known; otherwise retain unknown cost.
A cost estimate is not an invoice, and a configured allowance is not an account
quota guarantee. Delegated model calls consume the same worker allowance.

## Qualification boundaries

The overnight journey uses real local Git repositories, production worker timers
and a controlled model-process fixture. It checks pushed admission, independent
work during a question, Markdown-answer continuation, verification receipts,
review notes, feature branches and preservation of the developer checkout.
It does not demonstrate the quality of a paid model's implementation.

Native CLI argument, checkpoint and usage tests must be kept separate from live
subscription qualification. A fixture cannot establish that a particular account,
provider version or machine will remain authenticated overnight. Keep the worker
machine awake, run a smoke request with the configured provider, and use the
private journal and Markdown diagnostics to inspect failures.

The existing 100-owned-request retention ceiling remains explicit. This increment
does not introduce an archival policy, automatic merging, a night scheduler or a
provider-wide spending API. A future ACP/app-server adapter must independently
qualify authority isolation, recovery and usage before advertising its native
capabilities.
