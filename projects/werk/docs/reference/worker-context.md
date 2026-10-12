# Worker pinned context verification

A bound mock assignment carries a server-owned context reference: manifest
SHA-256, full commit object ID, feature ID and requirement path. The worker first
renews the current lease, then retrieves the stored manifest from its own
orchestrator with that exact task, lease and attempt. Historical context access
is not permission to execute an expired assignment.

Before calling the mock adapter, the worker checks the manifest's exact emitted
JSON digest, project and requirement identity, title and acceptance criteria,
file content hashes and UTF-8 byte counts, dependency graph, safe vault paths and
resolver limits. The independent serialized-manifest limit is 4 MiB. UTF-8 BOMs
remain part of the pinned file bytes. Heartbeat and terminal acknowledgment
responses must preserve the same context reference.

Source text stays ephemeral and untrusted. The verifier does not execute source
instructions, parse it as worker policy, open repository paths or persist full
manifest contents in worker telemetry. Before/after snapshots contain the
assigned context hash, feature ID and source commit. The hash identifies the
assigned inputs; it is not an assertion that context verification or code
execution succeeded. Verification failure prevents adapter execution, produces
a failed mock outcome with a generic diagnostic, and uses ordinary lease-fenced
abandonment. Raw repository content and remote diagnostics are not copied into
that diagnostic.

A durable terminal snapshot replays reporting only. It must match the assignment
pin, and neither refetches potentially changed context nor reruns the adapter.
After a crash, an incomplete pair retains the original before-record provenance
and becomes an explicitly interrupted recovery pair. Unbound mock assignments
keep their existing behavior and null context hash.

This is input verification for the mock runtime. It does not implement a live
provider runner, worktrees, Git publication, provider consumption of context,
review/merge gates or the complete P0-01 delivery scope. See
[pinned context resolution](pinned-context.md), [snapshot semantics](../explanation/snapshots.md)
and [worker retention](../how-to/worker-retention.md).
