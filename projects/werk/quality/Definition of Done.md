# Definition of Done

The default Git/Markdown workflow completes through its configured verified-candidate and human-acceptance gates, producing a PullRequest Markdown handoff. Shared delivery confirms its Git branch/note publication; local delivery retains its local review package. The primary journey then asks the user to allow the exact increment into the displayed assigned main checkout. New web-generated `localMerge: true` policy keeps delivery in progress until the guarded local merge is confirmed; older review-only policies keep their earlier completion semantics. The Markdown handoff and candidate acceptance alone cannot claim that merge. A hosting-service PR, GitHub CLI or GitHub Release is not required.

Evidence is evaluated at separate recorded boundaries; the final three are additional requirements only for the explicitly enabled managed GitHub release extension:

1. **Verified candidate:** required independent checks and criteria refer to the current request revision, candidate tree/commit, policy and check definitions. Agent statements do not establish passing evidence.
2. **Accepted candidate:** required human decisions identify that exact candidate. New code or scope invalidates earlier acceptance and checks.
3. **Optional GitHub merged increment:** the hosting service confirms the intended PR is merged into the configured base and records its actual merge commit. A closed PR, local acceptance or published branch does not satisfy this boundary.
4. **Optional managed built release:** the configured build succeeds from the exact merged commit and retains a nonempty artifact inventory with byte counts and SHA-256 digests.
5. **Optional GitHub published release:** the configured GitHub repository/tag resolves to the intended source, release visibility is confirmed, and every expected asset matches the retained inventory.

Requests without release policy keep their established local-review completion semantics. For the full release workflow, neither a passing build nor a remote PR alone establishes completion. Failed, stale, unavailable and unknown evidence blocks the corresponding boundary and preserves the last known successful milestone.

See the [primary workflow contract](../docs/reference/worker-release-workflow.md) for recovery and qualification.
