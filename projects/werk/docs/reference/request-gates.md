# Worker request gates

Request gates separate readiness to execute from acceptance of a recorded result.
The worker evaluates a frozen policy against application-owned facts. Model
completion alone does not establish Request Done, applied changes, passing tests
or a merge. See [reworking requests](../how-to/rework-worker-requests.md) for the
operator workflow.

## Authority and snapshots

Each request retains its ID, revision, input revision, accepted input/hash,
provider profile, policy/digest, evaluations, findings, candidates and advisory
runs. Editing future defaults does not alter an existing request's policy.
Accepted file snapshots and context remain fixed across text rework. A candidate
requires explicit acceptance and creates a new input generation; history remains
available.

Readiness (`ready`) runs before primary admission. Completion (`done`) runs after
a known result is durably recorded. Missing, null or unsupported facts fail
closed, including a `neq` comparison. Advisory prose cannot supply trusted facts.
The default readiness policy requires nonempty bounded text; patch requests also
need approved files and valid paths. Default completion requires a completed,
nonempty result without pending input; patches additionally need valid patch
protocol and a patch artifact. The restricted legacy result policy does not itself require operator acceptance.
Local delivery additionally requires human acceptance of the current candidate:
automated completion places the Feature Request in review, never directly in done.

## Policy format

`request policy` returns the current policy and its revision/digest. A policy has
`schemaVersion: 1`, an ID/version, `ready` and `done` rule arrays for `chat` and
`patch`, `reviewer`, and `rework`. Each rule contains `id`, `fact`, `op` and `value`.
Operators are `eq`, `neq`, `gte` and `lte`; numeric comparisons require numeric
facts. Use `request schema` for the current rule bounds and the portable `schema`
command for command flags. The release also ships the [JSON schema](../../schemas/request-gates.schema.json).

| Fact | Meaning |
| --- | --- |
| `input.kind`, `input.titleLength`, `input.messageLength` | Accepted input shape |
| `input.criteriaCount`, `input.approvedFileCount`, `input.approvedBytes`, `input.pathsValid` | Retained criteria and approved snapshots; unknown bytes remain unknown |
| `output.nonEmpty`, `output.protocolValid`, `output.patchPresent`, `output.changedFileCount` | Worker-observed result/artifact properties |
| `output.verificationPassed`, `output.requiredCheckCount`, `output.candidateDigest` | Current candidate and frozen required-command receipts observed by the worker; unknown for proposal-only tasks |
| `execution.recoverySafe`, `execution.outcome` | Recorded execution checkpoint |
| `pending.count`, `findings.blockingCount` | Current unresolved input and blockers |
| `operator.accepted` | Explicit acceptance bound to this input and output digest |
| `tests.passed`, `build.passed` | Require independent trusted evidence; a model statement is insufficient |

There is no test/build command runner in this restricted model lane. Do not add
rules requiring unavailable evidence and expect model prose to satisfy them.
Policy limits include at most 32 rules per stage/kind and a 64 KiB policy. The
reviewer is enabled by default, uses the same provider and allows one automatic
review per failed stage/input/policy generation. Explicit rework has a bounded
budget of up to three attempts.

## Committed local delivery policy

A Git-backed local delivery reads `.werk/delivery-policy.json` from its selected
committed baseline. Uncommitted edits to this file do not change an admitted run.
When absent, the worker uses the versioned defaults below. Request-level
`quality_profile` selects an allowed profile; it cannot replace mandatory worker
gates or tool authority.

```json
{
  "schemaVersion": 1,
  "version": 1,
  "defaultProfile": "feature",
  "reviewDirectory": "feature-reviews",
  "profiles": [
    {
      "id": "feature",
      "minimumCriteria": 1,
      "minimumMessageLength": 20,
      "maxRepairAttempts": 2,
      "verificationInputs": ["tests/", "test/", "scripts/", "package.json", "package-lock.json", "tsconfig.json"]
    },
    {
      "id": "lightweight",
      "minimumCriteria": 0,
      "minimumMessageLength": 1,
      "maxRepairAttempts": 1,
      "verificationInputs": ["tests/", "test/", "scripts/", "package.json", "package-lock.json", "tsconfig.json"]
    }
  ]
}
```

Both `feature` and `lightweight` must exist; up to 16 unique named profiles are
allowed. Repair allowance is 0–3, minimum criteria 0–64 and minimum message length
0–8,000 characters. The effective policy, digest, selected profile and baseline
are recorded with delivery. Settings exposes this effective policy for inspection;
change the project file through the team's reviewed Git workflow, then commit it
before using it for new work.

`verificationInputs` protects existing committed check/policy inputs from being
silently changed by the implementation. New regression files under a protected
folder can still be added. A deliberate edit to an existing protected test needs
an explicitly reviewed project policy change; an agent cannot turn a failing check
into success by removing its assertion. The policy file itself remains protected.

Review notes and sanitized evidence JSON are written under `reviewDirectory`,
outside the tested worktree; raw check command/output records remain private.
The default is `feature-reviews`. A complete local candidate identifies its own
`werk/delivery/...` branch and commit; this does not push a branch or create a
remote PR. Exemptions and not-applicable outcomes are not granted by the default
local policy. Unknown, failed or stale required checks remain blocked.

## Delivery criteria and acceptance

Local delivery records a criterion result as `passed`, `failed`, `unknown`,
`not_applicable`, `pending_human` or `stale`. Deterministic checks retain command,
content/check-definition binding and environment evidence. Manual criteria stay
pending until a current-candidate decision records their outcomes. An unavailable
tool, timeout or missing artifact cannot become a passing result. Exemptions need
a separate attributable, revision-scoped authorization.

The delivery candidate identifies the request/input revision, run, explicit Git
baseline, branch, candidate commit/tree, candidate/patch digests and pinned policy
and check-definition digests. Relevant changes invalidate evidence and acceptance.
A local review package is an observed local artifact; remote publication remains
a separate delivery operation. See the [canonical request contract](feature-requests.md#canonical-local-delivery-requests).

The delivery lifecycle (`draft`, `submitted`, `ready`, `in_progress`, `in_review`,
`done`, `cancelled`) is separate from execution status and phase. Internal gate
phases below remain diagnostic state and must not be presented as equivalent to
human acceptance. A delivery run can contain several measured model invocations.

## States and advisory work

Phases include `readiness`, `needs_rework`, `ready`, `running`, `waiting_input`,
`escalated`, `review`, `done`, `failed`, `cancelled` and `interrupted`. Read the
latest evaluation to distinguish a deterministic failure from an advisory blocker.
Assignment (`operator` or `llm`) records responsibility; assignment alone does not
invoke a model.

An automatic review or explicitly requested model rework uses the normal serial
execution slot and frozen provider profile. It has no tools or command permission.
Its strict response contains bounded question/issue/gap findings and optionally
revised request text. It cannot replace policy, facts, approved files or operator
attestation. Review/rework failures and interrupted calls remain visible; uncertain
inference is not automatically replayed after restart. Resolve advisory findings
with an explicit operator note. Deterministic failures need corrected input or
trusted evidence followed by evaluation.

## CLI and private API

For an installed project, use `node runtime/bin/apps/worker/cli.mjs --state-dir state/worker` with
`--state-dir .werk/worker`. Read commands are `request list`, `get`, `events`,
`schema` and `policy`. Mutations are `set-policy`, `evaluate`, `execute`, `assign`,
`rework`, `attest`, `resolve`, `propose`, `accept` and `cancel`.

Every mutation requires `--if-match` and `--key`; all except `set-policy` also
require `--id`. The revision belongs to the request, or to the policy for
`set-policy`. JSON `--file` contains only action-specific fields. `execute` and
`cancel` take no file. Keep the exact body and key stable when retrying an uncertain
response; a changed body with the same key is rejected. Read the current revision
before a new operation.

Authenticated `POST /api/requests` exposes the same contract using canonical
actions such as `set_policy`, `resolve_finding` and `accept_candidate`, with
`requestId`, `expectedRevision` and `operationId`. Delivery controls also identify
`deliveryRunId` and `inputRevision`; the UI exposes only compatible actions.
`pause_after_step`, `interrupt`, `resume`, `retry` and `reopen` use the same operation
ledger. Repeating an operation never supplies authority to repeat an uncertain
side effect. Private request/event content
can include project text; access remains protected.

Command receipt and primary admission are separate checkpoints. The response's
`dispatch` describes the current input generation: `not_requested`, `not_admitted`
or `admitted`. Admission is not completion. An identical receipt replay never
starts new inference. If admission failed after the receipt was saved, read the
current request and, if still ready, issue a new guarded `execute` with a new key.
This is not an exactly-once inference or billing guarantee.

## Evidence and projections

`run list`, `run analyze` and `run export` accept
`--purpose execution|gate_review|rework`. Historical runs without purpose count
as `execution` when filtering. Advisory consumption remains separate; unknown
usage stays unknown and reported cost is not automatically actual billed cost.

Feature projections live under `_gates/<feature-id>/request.md`, `questions.md`
and `gaps.md`. Managed `werk.gates` links refer to canonical journal state.
Feature status retains the established execution lifecycle while a request is
ready, running or done; a held gate exposes its request phase. `werk.gates.phase`
always identifies canonical request state, and `werk.executionStatus` retains the
execution outcome. A patch can therefore remain in review while its configured
request completion gate has passed. Editing generated projections or metadata neither satisfies a
gate nor changes accepted input. Original accepted Markdown body/hash stay retained.

Remote requests retain orchestrator input and lease ownership. Local rework cannot
replace their accepted input. Use an upstream successor with the owning attempt,
evaluation and operation key; see the [rework guide](../how-to/rework-worker-requests.md).

For new implementation requests, the worker derives candidate verification from actual worktree contents and required command results. Changing files invalidates prior checks. These output facts participate in the saved result digest; model prose cannot supply them. Add `output.verificationPassed == true` to a project completion policy when proposal-only results must remain held. Generic required commands do not automatically establish `tests.passed` or `build.passed`.
