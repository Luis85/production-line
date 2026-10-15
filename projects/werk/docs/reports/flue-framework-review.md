# Flue framework review and adopted patterns

Reviewed on 2026-10-15 against **Flue 2.3.0**, commit
[`deee93b40d275ecc9a50c50af2158f20089d54bc`](https://github.com/withastro/flue/commit/deee93b40d275ecc9a50c50af2158f20089d54bc)
(released 2026-10-12). The authoritative project is
[`withastro/flue`](https://github.com/withastro/flue), identified through GitHub
repository search and its own package metadata, README and documentation.
The review read the pinned documentation and implementation, then compared them
with Werk's current interaction, run evidence, provider and recovery contracts.
It did not execute Flue or evaluate live model quality.

Flue is a TypeScript agent harness with programmable tools, sandbox adapters,
sessions, skills, delegated agents, durability and observability. Its runtime is
Apache-2.0 licensed. Werk retains its independently deployable Factory,
orchestrator and worker applications; this change adopts two bounded patterns
without adding Flue as a dependency or copying its source.

## Findings and decisions

| Pattern and primary evidence | Werk comparison | Decision |
| --- | --- | --- |
| **Immutable, failure-isolated observations.** Flue separates durable conversation state from live operational observations. Subscribers receive a detached, frozen snapshot; synchronous exceptions and rejected promises cannot interrupt agent work. [Observability guide][observability], [observation snapshots][snapshots], [event delivery][events]. | Werk already keeps prompt text and credentials out of numeric run exports. CLI process cleanup catches synchronous telemetry errors, but API usage observers previously ran directly. A rejected async callback could escape, and adapters could retain a mutable usage object or invoke the callback after settlement. | **Adopted.** `observeModelInvocation` now guards typed, legacy, API and CLI entry points. Each usage delivery is cloned and recursively frozen; callback failures are isolated, promises are observed without awaiting, and callbacks received after invocation settlement are ignored. Existing application callbacks still flag persistence failures themselves. This does not make authoritative journal writes optional. |
| **Cancellation fences late success.** Flue's abort helper consumes late promise results and checks the signal again at settlement. Its generic tool helper can abandon signal-unaware work. [Abort implementation][abort], [durability guide][durability]. | Werk's task controllers already recheck cancellation after awaiting providers. Direct model consumers lacked that common boundary check. Werk also has a stricter single-execution permit and native process-group cleanup that must finish before another task starts. | **Adopted with a deliberate constraint.** The common invocation boundary rejects successful results returned after cancellation. It continues to await adapter settlement and preserves usage reported during cleanup. It never races away from native execution, starts another attempt early or automatically retries an uncertain result. |
| **Durable admission before work; immutable terminal evidence.** Flue records submissions before acknowledging them and settles accepted work durably. Recovery uses recorded evidence and refuses to blindly rerun ordinary tools with unknown side effects. [Durability guide][durability], [database guide][database]. | Werk's interaction journal already deduplicates an operation ID and input digest, freezes prepared dispatches, stores completed results before projections, and marks interrupted turns for explicit operator resume. Run evidence and request gates retain distinct identities and outcomes. | **Preserved.** No second submission queue or journal was introduced. Flue's automatic model/tool replay is deferred because Werk's existing explicit resume and patch-review contracts remain authoritative. |
| **Subagents have explicit capabilities and separate context.** Flue delegates receive a focused task, their own instructions, tools and skills, while sharing the parent's sandbox. Model and reasoning overrides are explicit. [Subagents guide][subagents]. | Werk currently declares no delegated agents or model tools in its structured model contract. Its advisory reviewer has its own immutable run identity and provider selection, and uses the shared execution permit. | **Deferred.** Runtime delegation needs an explicit product contract for capacity, workspace ownership, costs, cancellation and human review. Adding a `task` tool would change the worker's current authority and cannot be represented as a documentation-only feature. |
| **A sandbox is an explicit capability boundary.** Flue distinguishes an isolated virtual filesystem from `local()`, which uses the host and is explicitly not an isolation boundary. It also separates conversation durability from workspace durability. [Sandboxes guide][sandboxes], [database guide][database]. | Werk's provider invocations use restricted read-only chat execution or disposable allowlisted patch workspaces; runtime credentials and private state remain outside model-writable files. Codex process cleanup already kills remaining descendants, including when the parent exits first. | **Preserved.** No local shell or network permissions were broadened. A future remote sandbox adapter must preserve the current patch and recovery contracts rather than treating persisted conversations as persisted workspaces. |
| **Evals exercise observable behavior and stay separate from deterministic tests.** Flue recommends independent live-model suites, isolated conversations and outcome assertions; real evals spend tokens and may vary. [Evals guide][evals]. | Werk already has deterministic fixture-backed provider and browser qualification, plus separately gated live-provider checks. The generated UI storybook uses fixtures to document reproducible states. | **Preserved.** Storybook screenshots and the regression tests here are deterministic product evidence, not claims about live model performance. No paid provider evaluation was added to the release gate. |

## Implemented behavior

The shared boundary lives in `src/worker/application/model-contract.ts` and is
used by `executeModel`, legacy replies and the built-in adapters in
`src/worker/infrastructure/providers.ts` and
`src/worker/infrastructure/conversation.ts`.

The outcome remains the provider's outcome even if an observation callback
throws, rejects or attempts to mutate usage. Callback failures do not trigger
another provider invocation and do not replace safe provider error
classifications. The helper does not log callback exception text, which may
contain application-private information.

Cancellation still waits for the adapter. Usage delivered before that adapter
settles can be retained, including terminal CLI usage collected during process
cleanup. Once settled, a provider's retained callback cannot rewrite evidence.
A successful value that arrives after cancellation is rejected as `cancelled`.
An adapter that never settles can still hold the execution permit: removing that
limit requires a verified cleanup or abandonment contract, not just a promise
timeout.

## Qualification

`tests/worker/provider-observation.test.mjs` covers eight behaviors:

- Throwing and rejected async observers preserve API success and HTTP error
  classifications across direct typed execution and legacy replies.
- Detached, frozen snapshots prevent observer and provider mutation from
  rewriting recorded usage.
- Retained callbacks after successful or failed settlement are ignored.
- A pending async observer does not delay model settlement.
- Cancellation retains the serial execution permit until cleanup completes,
  preserves terminal usage, rejects stale success and then permits queued work.
- A pre-aborted direct API call performs no transport work.
- Direct API success returned after abort is rejected while measured usage is
  retained.
- Both CLI adapters isolate rejected async observers and expose frozen usage.

The focused model-contract, provider-usage and provider-observation suites pass
**29 tests**. Typechecking and a worker-only distribution build also pass.
The CLI cases use local executable fixtures, with no provider credentials or
live model calls. Reproduce from the Werk project:

```sh
npm run typecheck
node scripts/build.mjs worker --dist-only
node --test tests/worker/provider-observation.test.mjs tests/worker/provider-usage.test.mjs tests/worker/model-contract.test.mjs
```

The complete release qualification remains the project check and generated
storybook workflow; this focused report does not replace those gates.

## Pinned primary sources

- [Flue overview and package inventory][readme].
- [Runtime package metadata, version and license][package].
- [Durability: accepted work, recovery, unknown outcomes and side effects][durability].
- [Database: canonical conversations and storage ownership][database].
- [Observability: durable product state and live operations][observability].
- [Immutable observation snapshot implementation][snapshots].
- [Observer delivery and promise rejection isolation][events].
- [Abort handling and late-result fencing][abort].
- [Subagent context and capability inheritance][subagents].
- [Sandbox isolation and workspace lifetime][sandboxes].
- [Evals and the separation of live model qualification][evals].

[readme]: https://github.com/withastro/flue/blob/deee93b40d275ecc9a50c50af2158f20089d54bc/README.md
[package]: https://github.com/withastro/flue/blob/deee93b40d275ecc9a50c50af2158f20089d54bc/packages/runtime/package.json
[durability]: https://github.com/withastro/flue/blob/deee93b40d275ecc9a50c50af2158f20089d54bc/apps/docs/src/content/docs/guide/durability.md
[database]: https://github.com/withastro/flue/blob/deee93b40d275ecc9a50c50af2158f20089d54bc/apps/docs/src/content/docs/guide/database.md
[observability]: https://github.com/withastro/flue/blob/deee93b40d275ecc9a50c50af2158f20089d54bc/apps/docs/src/content/docs/guide/observability.md
[snapshots]: https://github.com/withastro/flue/blob/deee93b40d275ecc9a50c50af2158f20089d54bc/packages/runtime/src/observation.ts
[events]: https://github.com/withastro/flue/blob/deee93b40d275ecc9a50c50af2158f20089d54bc/packages/runtime/src/runtime/events.ts
[abort]: https://github.com/withastro/flue/blob/deee93b40d275ecc9a50c50af2158f20089d54bc/packages/runtime/src/abort.ts
[subagents]: https://github.com/withastro/flue/blob/deee93b40d275ecc9a50c50af2158f20089d54bc/apps/docs/src/content/docs/guide/subagents.md
[sandboxes]: https://github.com/withastro/flue/blob/deee93b40d275ecc9a50c50af2158f20089d54bc/apps/docs/src/content/docs/guide/sandboxes.md
[evals]: https://github.com/withastro/flue/blob/deee93b40d275ecc9a50c50af2158f20089d54bc/apps/docs/src/content/docs/guide/evals.md
