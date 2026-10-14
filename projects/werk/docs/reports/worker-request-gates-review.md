# Worker request gates and recovery review

Date: 2026-10-14. Scope: the current working-tree request-gate application,
advisory reviewer/rework manager, local owners, remote lease recovery and run
accounting. This is source review and fixture validation; it is not evidence of
live provider execution or a published release.

## Findings and resulting behavior

No remaining confirmed critical defect was found in the inspected gate and
recovery paths. Readiness is evaluated before primary interaction/run admission.
Known model results remain authoritative when later gate, patch or transcript
projections fail. Completion is evaluated from recorded application facts; model
prose cannot establish tests, builds, operator acceptance or merge authority.

An advisory reviewer runs through the worker's existing serial execution permit.
Its durable intent saves the exact provider/model/instruction profile and rendered
request before invocation. Review and explicit model rework have separate run
purposes and consumption totals. Their candidates can change request text only;
approved file snapshots, kind, criteria and context remain preserved. Candidate
acceptance requires the current revision and creates a new input generation.
Human proposals do not prompt a model. Missing providers and invalid advisory
responses fail once; unknown interrupted calls do not automatically replay after
restart. Session-specific cancellation drains an active reviewer before cleanup.

Remote requests retain the owning orchestrator, task, accepted context and lease
checkpoint. Readiness holds skip primary execution. Known results reconstruct
terminal evidence without another model call, while conflicting checkpoint
ownership stays held. A local operator cannot silently replace remote accepted
input; an upstream successor is required. Passing a held completion gate can
reconcile the owning historical lease without rewriting its original snapshots.

The identified cross-journal boundary is intentionally conservative: saving an
execution command receipt and admitting primary work are separate checkpoints.
An owner-admission failure can leave a saved receipt and a ready request without
primary admission. Exact operation-ID replay acknowledges that receipt and never
prompts newer work. Responses now report `dispatch.scope: current_input_generation`,
the input revision and `not_requested`, `not_admitted` or `admitted`. Admission
errors explain that the receipt was saved. Recovery reads the current request
and, if its current generation remains ready, issues a new guarded execute with
a new operation ID. `admitted` does not imply completed. This is not an
exactly-once cross-journal or billing guarantee.

## Validation evidence

Node 24.19.0 source execution through an isolated TypeScript test loader passed
36 focused checks without rebuilding or altering application distributions:

- 14 reviewer/accounting checks: strict response bounds and authority rejection,
  frozen dispatch-before-call, shared permit, obsolete-generation rejection,
  unavailable-provider behavior, typed questions, explicit rework, interruption,
  deadline usage retention, projection failure, session drain, actual SQLite
  candidate revision guards and purpose-filtered pagination/totals.
- One actual workspace-controller/SQLite fault scenario: owner admission fails
  after the command receipt is saved; identical replay causes zero admissions;
  a new guarded operation admits once; later old receipt replay never admits
  again.
- 21 existing journal, local-patch and remote-lease scenarios: held readiness
  across restart, immutable accepted rework, invalid patch rejection, known
  result projection recovery, operator attestation bound to exact output,
  interrupted checkpoints, remote holds and reconstruction, late reviewer
  cancellation, queued intent supersession and historical lease reconciliation.

The focused compiled-suite entrypoints are
[request review](../../tests/worker/request-review.test.mjs),
[command admission](../../tests/worker/request-command-admission.test.mjs),
[request journals](../../tests/worker/worker-request-gates.test.mjs),
[local task gates](../../tests/worker/local-task-gates.test.mjs) and
[remote gates](../../tests/worker/worker-remote-request-gates.test.mjs).
The all-application TypeScript/Vue typecheck and strict documentation validation
also passed during this review. Final assembled builds, the complete suite and
fresh archive qualification belong to the parent integration pass.

No paid inference, provider subscription session, remote provider cancellation
or 24-hour soak was exercised. Model callbacks and explicit protocol fixtures
prove worker orchestration, not provider reliability, actual billed cost or
exactly-once remote effects. Worker resource snapshots measure the Node process,
not provider subprocesses or the entire host.

## Primary-source basis

The official [JSON Schema conditional validation reference](https://json-schema.org/understanding-json-schema/reference/conditionals)
describes dependencies and conditional validation of supplied data. Schema shape
validation cannot independently verify external execution or authority. The
[W3C SCXML specification](https://www.w3.org/TR/scxml/) supplies the event/guarded
transition model supporting explicit readiness, completion and rework states;
Werk uses its own bounded application contract rather than an SCXML dependency.

[Temporal workflow execution](https://docs.temporal.io/workflow-execution) separates
durable history/reconstruction from external side effects, and its
[activity documentation](https://docs.temporal.io/activity-definition) recommends
idempotency where activities can retry. Werk does not use Temporal and does not
assume paid inference is idempotent. Persisted intents, explicit recovery and
known-result checkpoints are the applied design inference. Provider-specific
continuation and subscription limits remain documented in the
[subscription research](worker-subscription-research.md).
