# Worker journal retention

Workers retain the latest 1000 locally acknowledged attempt pairs by default. Set
`--retain-acknowledged-pairs N`, or `journal.retainedPairs` in the worker JSON
configuration, to choose an integer from 0 to 100000. Zero removes acknowledged
local pairs immediately. This storage setting does not change the execution
configuration hash or invalidate an existing worker identity.

A pair becomes eligible only after both snapshot payloads receive validated
identity/digest acknowledgments and the orchestrator acknowledges completion or
abandonment. The worker then atomically writes a versioned `acknowledged.json`
checkpoint beside the immutable before/after files, containing their digests,
worker identity and acknowledgment time. Delivery of snapshots alone never
makes terminal-reporting evidence eligible for removal.

On restart, valid checkpointed pairs are verified and skipped during publication.
Incomplete or unacknowledged pairs retain the existing recovery behavior: before
records are replayed, missing after records become explicitly interrupted
recovery evidence, and an existing terminal result is never rerun merely because
completion reporting failed. Older journals without checkpoints are retained and
replayed conservatively; an empty outbox does not prove terminal acknowledgment.

Collection removes only the worker's local acknowledged pair directories. It
keeps a durable checkpoint until both evidence files have been removed and the
directory changes synced. A process restart finishes interrupted collection
without creating replacement measurements. Unknown files, corrupt digests,
foreign worker identities and symlinked files fail closed. Node cannot sync
parent directory handles on Windows; power-loss guarantees remain subject to
that platform's filesystem behavior. Successful local checkpoint persistence is
separate from an orchestrator backup or disaster-recovery guarantee.

This policy does not delete orchestrator telemetry, repository `.factory/runs`
artifacts, unacknowledged outbox entries or incomplete attempts. Those require
separate capacity monitoring and retention policies. During a long outage,
unacknowledged local evidence can still grow: reserve disk capacity and alert on
free space. A lost terminal response or a failed checkpoint write leaves evidence
ineligible for automatic cleanup. Do not infer acknowledgment from filenames,
empty outboxes, an expired lease or elapsed time, and do not manually delete
recovery evidence to silence an error.

See [snapshot semantics](../explanation/snapshots.md) and [operations and recovery](operations.md)
for publication, backups and recovery procedures.
