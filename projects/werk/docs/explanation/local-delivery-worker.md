# Local delivery around one Feature Request

The local delivery iteration extends Werk's existing Feature Request workflow. A request stays the team's durable unit of work from drafting through clarification, implementation, verification and human review. The webview and Markdown are two ways to interact with that same request.

This document records the implementation direction for [PRD-LDW-001](https://github.com/Luis85/production-line/blob/main/projects/werk/imports/local-delivery-worker-prd.md). The [acceptance ledger](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reports/2026-10-20-local-delivery-acceptance.md) distinguishes implemented evidence from pending qualification; this explanation is not a release acceptance claim.

## Scope and decisions

| Decision | Reason and boundary |
| --- | --- |
| Implement R1 inside Werk | Reuse the TypeScript daemon, Vue webview, durable request journal, workspaces and provider ports. The PRD's Rust suggestion is optional. |
| Preserve existing providers and shared Git intake | Local delivery adds a mode to the central request workflow. Existing remote ownership, publication and provider constraints continue to apply. |
| Pilot Windows with Claude Code | The user selected this combination. Linux fixture execution does not qualify native Windows or a real Claude account. |
| Keep human acceptance separate from successful checks | A verified implementation is ready for review. Only a valid decision about the current revision and candidate can complete the request. |
| Keep remote delivery explicit | A local review note is not a remote pull request. Push, remote PR creation, merge and release each require their configured, separately recorded action. |
| Preserve source requirements | The imported PRD remains byte-identical. Implementation choices and unresolved gaps belong in the acceptance ledger. |

## The user's journey

1. Register the project repository, intake directory and committed baseline. Configure the provider connection, allowed tools, quality policy, timeouts and repair limits. Diagnose prerequisites before enabling execution.
2. Create a Feature Request from the template. Keep it a draft while describing the outcome, scope, observable acceptance criteria and boundaries. Its ID remains stable when the file is renamed.
3. Submit the request. Local mode observes stable local saves; shared Git intake retains its commit-and-push handoff. The selected mode is visible and does not silently change another intake's authority.
4. Resolve readiness findings in the request. Questions explain the required decision and its impact. Answers form a new semantic revision, while generated status and scheduling changes do not create new implementation work.
5. Let the worker prepare an assignment against an explicit baseline and isolated workspace. The assignment records the accepted request revision, model profile, permitted actions, criteria and limits.
6. Follow the request in Markdown or the webview. Request lifecycle, run status and execution phase answer different questions: whether the feature is accepted, whether execution can proceed, and what the worker is currently doing.
7. Inspect checks and any bounded repair attempts. A model's completion statement does not establish a passing build or test. Missing or stale evidence remains visible and blocks the relevant gate.
8. Review the local candidate and its Markdown package. Check the linked branch/commit, criterion results, failed or unavailable checks, limitations and required manual work. Record acceptance or request changes against that exact candidate.
9. Publish or merge through the team's configured delivery workflow. Local acceptance does not imply that a remote branch, PR, merge or release exists.

## Request authority and communication

The user owns the request's outcome, scope, criteria, references, answers and explicit commands. The worker's region is a readable projection of durable execution facts. Editing that generated projection cannot manufacture verification or acceptance.

The canonical local format is `worker.request/v1`, with explicit `id` and `intent: draft` or `intent: submit`. Legacy Werk notes remain supported through their versioned format. Migration must retain their identities and execution history. A changed requirement is a new revision of the same Feature Request; a terminal request needs an explicit reopen command.

Control and review commands carry a unique ID. Repeated saves acknowledge the recorded result; reusing that ID for a different payload is rejected. The webview submits the same validated application commands. Review decisions also identify the request revision and candidate commit; required manual criteria need their own recorded outcomes.

Concurrent editing must preserve user text or a recoverable conflict copy. Managed-note updates require a writable local volume with hard-link support (such as NTFS); unsupported volumes are rejected before the original note is displaced. Missing, malformed or ambiguous active sources need reconciliation before further new task actions. The current artifact and scale boundaries are recorded in the acceptance ledger rather than inferred from illustrative PRD configuration.

## Execution and evidence

A delivery run can contain several steps and provider invocations. Existing invocation records remain useful for sessions, usage and process observation; they are not relabelled as a complete delivery run. The durable request and its run history link assessment, preparation, implementation, verification, repair and packaging.

Pause intake prevents additional runs. Pause after step waits at the next bounded step. Interrupt requests cessation and reports the actual result. Cancel closes work only after the execution outcome is known. Recovery reconciles an uncertain invocation or Git operation before attempting it again.

An unknown operation never resumes automatically. After a restart, inspect the
host and stop any surviving provider or development-service processes before
using **Confirm stopped** in the request workspace. This records your inspection
as an operator attestation, together with a freshly captured owned-worktree
candidate digest. It does not claim that the worker observed the former process
exit or knows whether an unrecorded side effect completed. The worker rejects the
command while it still manages a live operation or the workspace identity has
changed. Resume is a separate decision; a pending cancellation instead closes
with the retained partial-work identity.

The equivalent Markdown command uses the current run and input revision from
the generated worker region:

```yaml
control:
  command_id: confirm-stopped-2026-10-20-01
  action: confirm_stopped
  run_id: current-delivery-run-id
  request_revision: 1
  note: I inspected the host, stopped the prior processes, and retained the partial work.
```

Use a new command ID for a new decision. Repeated saves replay the first receipt;
changing the note under the same ID is rejected. After confirmation, use a
separate `resume` command only when the preserved work is safe to continue.

Evidence identifies its request, requirement revision, candidate, check definition, evaluator, environment and observation time. A relevant code, baseline, requirement or check-definition change makes earlier evidence stale. Automated criteria and manual criteria have separate outcomes; unavailable observations do not become zero-cost or passing results.

The worker uses its own Git workspace and preserves the developer's checkout and staging area. Candidate packaging must not mutate the very code tree it claims was verified. Unaccepted work and its evidence remain inspectable after a failure, interruption or cancellation.

## Qualification and further reading

The implementation is assessed with real filesystem/Git fixtures, deterministic provider protocol fixtures, browser interactions and a separate native provider pilot. Each proves a different boundary. In particular, mocked provider output proves neither provider account eligibility nor the reliability of an installed runtime on another operating system.

Use the [project worker guide](../how-to/project-worker.md), [shared intake guide](../how-to/shared-feature-intake.md), [worker webview guide](../how-to/use-worker-webview.md) and [execution modes](modes.md) for operating instructions. The [acceptance ledger](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/reports/2026-10-20-local-delivery-acceptance.md) is the source for iteration-specific coverage, limitations and pending work.
