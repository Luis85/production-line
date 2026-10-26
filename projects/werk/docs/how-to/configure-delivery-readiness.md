# Configure readiness and explicit criterion decisions

Werk treats the Feature Request as the durable workflow. Readiness judgments, your decisions, implementation checks and human acceptance belong to that request and its exact revision. Markdown commands and the webview use the same application rules.

## Install and approve a project policy

A newly installed team authoring kit creates `.werk/delivery-policy.json` with a version 2 starter. Its `feature` and `lightweight` profiles require a structured readiness assessment. The feature scope estimate limit is 240 minutes; lightweight is 30 minutes. These are planning estimates; execution timeouts and consumption limits still apply independently. The new-installation manifest requires the policy to exist at the selected committed baseline: saving the generated file without committing it cannot silently activate legacy defaults. After committing it, approve its exact configuration locally.

Existing projects with no policy file, and existing snapshots without `readiness`, retain their previous behavior. Rerunning setup for an existing workflow does not silently create new authority. To adopt the new checks, choose the project in **Projects**, then open **Edit project delivery policy**
(`/project?project=<id>&step=edit`), inspect the starter, save it, review and commit the file, then approve the exact committed policy on this worker. Saving a draft neither commits it nor changes an active request. A malformed committed policy remains blocked while its draft is repaired.

The [project delivery policy reference](../reference/delivery-policy.md) contains a complete example and all configuration bounds. Add this object to the chosen profile while preserving its other fields:

```json
{
  "readiness": {
    "assessment": "required",
    "assumptions": "explicit",
    "requiredReferences": ["docs/design.md"],
    "maxEstimatedMinutes": 240
  }
}
```

The reviewer assesses whether the outcome is understandable, the criteria are observable, and the scope is sufficiently defined. Each condition retains a reason and a pass, fail or unknown outcome. The worker separately inspects required regular files at the accepted Git baseline, up to 1 MiB each. A dirty local replacement cannot satisfy a missing committed reference. Dependencies, available tools, billing mode, permissions and budgets remain separate worker checks.

An unavailable semantic assessment blocks a profile that requires one. The optional pre-DoR grilling prompt and a completion-review profile are separate configured stages; neither substitutes for these readiness conditions. A failed or unknown condition produces a visible reason. Answer material questions in the Feature Request and let the worker reassess the new revision. An estimated scope above the limit needs a smaller request, a proposed decomposition that the team turns into bounded dependent requests, or a separately authorized profile change.

## Decide a proposed interpretation

The reviewer may propose an interpretation, assumption or decomposition. Proposed text does not replace your accepted requirements. In the webview, inspect the current readiness assessment and accept or reject a proposal with a reason. The equivalent command in the original request is:

```yaml
readiness_decision:
  command_id: adopt-interpretation-01
  request_revision: 1
  input_hash: copy-the-current-64-character-input-hash
  assessment_id: copy-current-assessment-id
  proposal_id: copy-proposal-id
  decision: accepted
  note: The team agrees with this precise interpretation.
```

Copy the actual input hash, assessment ID and proposal ID from the gate companion or webview; the placeholders above are not valid values. Use `rejected` to reject the proposal. The command has a once-consumed ID: repeating it returns the receipt, while changing its content under the same ID is rejected.

`assumptions: "allow_low_impact"` permits only explicitly classified low-impact assumptions without unresolved blocking questions. Material proposals still require an operator decision. Neither an explicit acceptance nor a permitted assumption can turn a failed semantic condition into a pass or answer another question implicitly. Accepted supplements enter the initial model dispatch and review package with their provenance. Changing input, policy or assessment makes earlier decisions historical.

## Grant a narrowly scoped exception

The default has no criterion exception permission. A project may allow an operator to record a reason for an exact check or human criterion:

```json
{
  "exceptions": {
    "exemptibleCriteria": ["check:unit"],
    "notApplicableCriteria": ["check:platform-specific"]
  }
}
```

Put this object on the selected quality profile, commit it, and approve that exact policy locally before a new request accepts it. IDs are exact; wildcards are rejected. Automated IDs are `check:` followed by the configured check ID. Copy a human criterion's full ID from the candidate review. These permissions do not grant tools, widen file scope, change billing or authorize publication.

When a known inactive checkpoint has a failed or unavailable criterion, the webview offers only decisions allowed by the accepted policy. The worker freshly inspects the owned worktree and immutable candidate ref before recording the decision. Active, uncertain or changed candidates must be reconciled first. Markdown uses the same command:

```yaml
criterion_decision:
  command_id: unit-exception-01
  request_revision: 1
  run_id: copy-current-delivery-run-id
  candidate_commit: copy-current-full-candidate-commit
  criterion_id: check:unit
  kind: exempted
  reason: The team accepts this documented failure for this exact candidate.
```

`not_applicable` is a separate permitted decision with its own reason. Both bind the request revision, input hash, run, baseline, candidate, policy and check definition. The original failed or unknown check remains unchanged; the package displays the decision separately. A baseline failure is diagnostic information and does not grant an exception. Changes to the candidate or authority invalidate previous eligibility. Unrelated holds remain blocking.

An eligible candidate is packaged for review without replaying a known completed model result. Acceptance still requires every remaining mandatory human outcome or its own authorized decision. A general approval cannot complete unspecified checks. Record optional review effort with `review_duration_minutes` inside the existing `review` command; omitted time stays unknown, not zero.

## Inspect the handover

The Markdown review identifies the canonical source, accepted outcome and supplements, retained plan, branch/commit/baseline, check and baseline evidence, current reviewer findings, approved exceptions and outstanding manual work. Provider summaries are labelled as model-reported. Unreported deviations are not claimed to be absent; compare the accepted scope with the exact diff.

See [the local delivery explanation](../explanation/local-delivery-worker.md), [request gate reference](../reference/request-gates.md), and [remote candidate publication](publish-worker-candidates.md). A local note, a push, a remote PR, human acceptance and merging remain separate recorded actions.
