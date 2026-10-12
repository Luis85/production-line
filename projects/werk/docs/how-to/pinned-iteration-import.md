# Import an iteration into a bound line

A bound line can import ready features from the same commit as its operator-owned
repository binding. The importer reads a local branch at one immutable commit;
the server independently resolves each requirement using its configured repository,
commit and vault. A caller cannot supply a manifest or select the server repository.
The default importer remains available for unbound legacy lines. Both modes run
simulated mock attempts.

```sh
node src/orchestrator/dist/orchestrator/cli.js iteration import \
  --repo /path/to/local/clone --branch iteration/week-1 \
  --project demo --iteration week-1 \
  --iteration-pr https://git.example/project/pull/12 \
  --features docs/features --context pinned --vault-root docs \
  --url http://127.0.0.1:3000
```

Use `WERK_ADMIN_TOKEN` for the target line. Supply `--context pinned` and
`--vault-root` together. The local branch must resolve to the server's configured
full commit. `--vault-root .` selects the repository root. A different local clone
is acceptable when its commit and source bytes match the server-owned objects.
`--dry-run true` collects and validates local planning metadata without contacting
the server; it does not attest that a remote line has a compatible binding.

Ready feature frontmatter uses the existing `factory_id`,
`factory_status: ready_for_implementation`, `factory_iteration`, `title`,
`factory_acceptance`, optional `factory_context`, `factory_provider` and
`factory_priority` fields. Only features matching the requested iteration are
planned. Pinned references use exact whole-note paths relative to the configured
vault. The [pinned-context subset](../reference/pinned-context.md) still applies, including
1–30 criteria and the existing task limit of 12 context links including the root.
The full manifest separately records transitive declared dependencies.

## Server contract

`POST /v1/iteration/tasks` requires admin authentication and `Idempotency-Key`.
Its body is the existing normalized task/source shape plus `requirementRef`.
The endpoint is available only with a server context binding. Regular
`POST /v1/tasks` retains its stricter minimal bound intake contract.

Before inserting, the server resolves the reference and compares the submitted
project, full commit, repository-relative root path, feature ID and raw source
SHA-256 against its own manifest. The source digest includes any UTF-8 BOM. It
reconstructs the expected task from that exact committed root text and compares
normalized title, criteria, dependency links, iteration, provider and priority.
Missing readiness, mismatched source, unsupported context and altered scheduling
metadata fail before that task is queued. Task, original request digest, manifest
and event commit atomically using the existing schema4 persistence contract.

Branch name and iteration PR URL are declared planning metadata. They receive
syntax validation and are retained for traceability; no remote provider is
contacted to verify a PR, branch owner, repository identity or review state.
Successful import does not claim publication or live execution.

## Retry and partial progress

The importer uses a stable key derived from project, iteration and feature ID.
An identical pinned request returns the original task after a lost response,
restart, binding change or repository loss. Changed input under the same key
conflicts. Existing unbound tasks cannot become pinned through replay: the pinned
endpoint returns 409 and the importer reports `revision_required`. Existing
pinned tasks with a changed commit or specification likewise require an explicit
revision decision. There is no implicit task rewrite or automatic migration.

All local feature files are collected and validated before submission, and the
existing task inventory is loaded before the first write. Submissions then run
sequentially. The whole iteration is not one transaction: a server validation,
network or capacity failure after earlier successes leaves those successes
committed. Correct the cause and retry unchanged input; do not generate new keys
for uncertain responses. An invalid dependency encountered only during server
resolution can therefore stop a partially submitted iteration.

## Resource and compatibility limits

Collection accepts at most 1,000 feature files, 512 KiB per file and 8 MiB total
UTF-8 source. The Git adapter reads only regular committed blobs, disables
replacement objects and lazy fetching, and limits the tree to 10,000 entries /
4 MiB output. Branch names are bounded to 200 characters, feature-folder arguments
to 500 characters, and Git subprocesses have a ten-second timeout.

Inventory traversal requests 100 tasks per page, rejects malformed/nonadvancing
continuations, and retains at most 10,000 tasks / 16 MiB serialized task data.
Legacy servers may omit pagination metadata, but the same inventory caps apply.
Collection and submission concurrency is one per CLI process; the server retains
its two-resolution admission bound and eight-second resolution deadline. These
are finite resource bounds, not an overall CLI wall-clock deadline or a streaming
constant-memory import. Large inventories require an operator decision rather
than silent truncation.

Omit `--context` and `--vault-root` to retain the legacy unbound import shape and
endpoint. Existing records and idempotency keys remain unchanged. Legacy mode
still rejects a bound server's minimal task contract; select pinned mode explicitly.
