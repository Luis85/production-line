# Definition of Done

Completion is evaluated at separate recorded boundaries:

1. **Verified candidate:** required independent checks and criteria refer to the current request revision, candidate tree/commit, policy and check definitions. Agent statements do not establish passing evidence.
2. **Accepted candidate:** required human decisions identify that exact candidate. New code or scope invalidates earlier acceptance and checks.
3. **Merged increment:** the hosting service confirms the intended PR is merged into the configured base and records its actual merge commit. A closed PR, local acceptance or published branch does not satisfy this boundary.
4. **Built release:** the configured build succeeds from the exact merged commit and retains a nonempty artifact inventory with byte counts and SHA-256 digests.
5. **Published release:** the configured GitHub repository/tag resolves to the intended source, release visibility is confirmed, and every expected asset matches the retained inventory.

Requests without release policy keep their established local-review completion semantics. For the full release workflow, neither a passing build nor a remote PR alone establishes completion. Failed, stale, unavailable and unknown evidence blocks the corresponding boundary and preserves the last known successful milestone.

See the [primary workflow contract](../docs/reference/worker-release-workflow.md) for recovery and qualification.
