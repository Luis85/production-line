# Local delivery provider profiles

Research reviewed 2026-10-20 against the vendors' official documentation. This implements PRD-LDW-001 FR-PRV-006–009 without adding another request lifecycle.

## Accepted project authority

The committed `.werk/delivery-policy.json` may contain an `execution` section. It declares named `profiles`, `defaultProfile`, `allowedOverrides`, an optional `reviewProfile`, ordered conditional `routing`, and explicitly bounded `fallbackProfiles`/`fallbackOn`/`maxHandoffs`. Private worker approval binds the exact policy digest. Request `execution_profile` selects only an authorized override. Routing is deterministic: an explicit allowed override, then the first fully matching rule, then the default. The selection and rule are retained with the request.

Each profile explicitly declares provider, model, effort, authentication mode and execution boundary. All referenced imported agent instructions are resolved at admission and frozen, including reviewer and fallback profiles. Project files never contain API credentials. Rotating a key is possible; changing a saved connection from subscription to API billing cannot silently change an accepted run.

The optional pre-readiness reviewer also receives the accepted provider, billing mode and frozen agent instructions. Answers cannot replace those selectors. Its approval subject is the exact repository and policy digest; revoking that approval while a review waits for capacity prevents its paid invocation. Previously completed review evidence remains readable without dispatching again.

## Adapter capabilities

| Interface | Official authentication | Execution boundary | Continuation | Qualification limit |
| --- | --- | --- | --- | --- |
| Claude Code CLI | Claude account login or configured Anthropic API key | Restricted CLI invocation, explicit worker MCP grants, isolated settings; vendor managed policy still applies | Provider session when declared by the adapter | Windows is the selected live pilot; native inference must be observed on that machine |
| Codex CLI | ChatGPT login or configured OpenAI API key | Explicit sandbox/approval controls and worker grants | Current adapter declares worker context replay | Current adapter refuses Windows; POSIX contract fixtures do not qualify Windows support |
| Cursor CLI | Cursor login or configured Cursor API key | Cursor's own permissions, hooks and native tools, explicitly acknowledged as `provider_native` | New or resumed native session bound to one FR | Worker grants constrain only supplemental Werk tools; no claim that they constrain Cursor native access |
| OpenAI / Anthropic API | Configured provider API key | Worker-owned tool loop and granted operations | Worker context replay | Loss of a response after dispatch is an unknown remote outcome |

Claude's documented [programmatic mode](https://code.claude.com/docs/en/headless) and [CLI flags](https://code.claude.com/docs/en/cli-reference) support noninteractive structured output and explicit restrictions. Safe/restricted operation does not remove vendor-managed settings. The integration uses the official executable and login flow; see [Claude Code terms](https://code.claude.com/docs/en/legal-and-compliance).

Codex documents [noninteractive execution](https://developers.openai.com/codex/noninteractive) and [authentication](https://developers.openai.com/codex/auth). Session controls are adapter capabilities, not a promise that another provider can import a Codex session. The adapter's declared replay behavior remains explicit.

Cursor documents [headless mode](https://cursor.com/docs/cli/headless), [authentication](https://cursor.com/docs/cli/reference/authentication), and [native permissions](https://cursor.com/docs/cli/reference/permissions). Its [ACP interface](https://cursor.com/docs/cli/acp) offers another session protocol; adopting it would require a separate verified adapter. This implementation retains the explicitly selected CLI integration and native permission model.

## Separate candidate review

A configured review profile runs as a persisted `verifying` step with purpose `candidate_review`. The input contains the accepted request, exact checkpoint, bounded patch, observed checks and authorized criterion decisions. No worker tools are granted to the reviewer. Cursor uses its documented ask behavior and native permission boundary. A reviewer returns structured blocking or warning findings; blocking findings feed the existing bounded repair loop. After repair, the worker verifies the candidate again. A model assessment never creates human acceptance, replaces an actual check receipt, or exempts a failed check.

Assessments retain provider/profile selection, request and candidate identity, dispatch and evidence digests, invocation identity, summary and findings. Changes invalidate the earlier assessment. A crash after a saved result can derive the missing assessment from that result without another model invocation.

## Authorized handoff

Fallback is off unless the accepted policy names targets, triggers and a limit. Only known quota, rate-limit and unavailable-provider outcomes qualify; authentication, approval, cancellation, protocol errors and unknown completion do not. At most three handoffs are allowed. A source invocation must settle and its failed result must be durable before another provider is started.

The handoff retains the source/target profiles, exact request revision, candidate digest and checkpoint, changed paths/check findings, accepted plan, and a fresh logical session identity. Existing candidate edits remain in the same owned worktree. Provider-native session handles are never copied. Tool grants cannot expand during handoff; an explicitly authorized Cursor target still follows its separately disclosed native boundary. The primary FR selection remains unchanged, while each execution step and usage record identifies the provider actually invoked.

## Validation and native pilot

PRD §15.4 / AT-16 has the same deterministic scenarios for Claude Code, Codex and Cursor. The [delivery matrix](../../tests/worker/delivery-provider-runtime.test.mjs) uses the real request journal and deterministic model, check and checkpoint ports. The [CLI boundary matrix](../../tests/worker/provider-outcome-contract.test.mjs) launches real contained fixture processes through each adapter format. Together these two files passed 37 tests on the development host on 2026-10-20.

| Required scenario | Evidence exercised separately for all three providers |
| --- | --- |
| Successful task | Frozen provider/boundary selection, implementation, required check, separate candidate assessment, local review package and no human acceptance |
| Readiness waiting | Incomplete readiness prevents creation of a durable invocation; repeated evaluation appends no new events. A later model question also waits without verification or repair |
| Failed verification | A failed worker receipt drives bounded repair; the old failed and new passing candidate receipts remain distinct |
| Cancellation with partial edits | Retained candidate checkpoint in the delivery loop; a real contained CLI fixture writes a partial file, then cancellation waits for confirmed process exit and preserves that file |
| Authentication failure | Official-format structured errors normalize to authentication-required, hide private diagnostics, perform one dispatch and retain partial work |
| Provider limit | Rate-limit and quota outcomes remain distinct, do not automatically retry, and cannot silently change billing or authority |
| Restart/reconciliation | Closing and reopening the journal preserves a completed review and prevents model replay; an unresolved dispatch becomes outcome-unknown and repeated attempts remain blocked |
| Accurate review output | Request/input/candidate identities, actual check result, evidence reference, human-pending criteria and local-only publication agree; model review never creates acceptance |

The [exception continuation regression](../../tests/worker/delivery-exception-resume.test.mjs) additionally exercises a real Git repository, owned worktree, failing subprocess, fresh candidate inspection, exact authorized criterion decision, review packaging and restart. It proves that the original failed observation and provider result stay immutable. Changed patch, evidence hash, candidate, decision subject or active hold refuses restoration.

These are automated contract fixtures, not evidence that a real vendor completed software work on a particular host. The native installed-provider smoke portion of AT-16 remains unqualified until real pilot receipts are collected for the shipped host/provider versions.

Run the real pilot only deliberately, after building the worker and logging in through the official CLI:

```powershell
npm run pilot:provider -- --provider claude-cli --executable "C:\absolute\path\to\claude.exe" --allow-billable-model-call
```

`--help` and an invocation without the billable flag never dispatch a model. The harness creates a scratch repository, a real owned worktree, a required Node verification command, a canonical worker request and a local review package. It retains `pilot-result.json` with the exact host/CLI version, candidate and observed check results. It does not push or merge. Cursor additionally requires `--accept-cursor-native-permissions`. A passing receipt qualifies that exact combination; it is not proof for other platforms or providers. The selected Windows + Claude Code native pilot remains pending until run on an available Windows host with the user's login.
