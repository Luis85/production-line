# Commit-pinned requirement context

An operator can opt a server into commit-pinned requirement intake. The server
resolves ready requirements from its configured local repository, persists an
immutable context manifest, and gives assigned workers that exact context.
Without this configuration, reference intake remains unresolved. Both modes
execute simulated mock attempts; neither enables live Claude/Codex execution.

## Local preview

`context resolve` validates a ready requirement and emits the same deterministic
manifest without creating a task or changing server configuration.

After building the orchestrator, run:

```sh
node src/orchestrator/dist/orchestrator/cli.js context resolve \
  --repo /path/to/project-repository \
  --commit FULL_LOWERCASE_COMMIT_OBJECT_ID \
  --vault-root docs \
  --project demo \
  --wikilink '[[Features/Customer portal]]' > context.json
```

Use the full 40-character SHA-1 or 64-character SHA-256 commit object ID obtained
from a reviewed commit. Branches, tags, revision expressions and abbreviated
hashes are refused. `--vault-root .` selects the repository root. Repository path,
commit and vault root are explicit operator inputs; they are not server-owned
project authorization. No token or network service is needed. Errors go to
stderr and return exit 2; successful stdout contains only the manifest JSON.

The requirement's committed YAML frontmatter must declare:

```yaml
factory_id: customer-portal
factory_status: ready_for_implementation
title: Customer portal
factory_acceptance:
  - A signed-in customer can see their own orders.
factory_context:
  - '[[Specs/Order access]]'
```

The supported dependency graph is **only `factory_context` arrays**. Each listed
note can declare further `factory_context` links. Ordinary prose, Markdown links,
inline Wikilinks and frontmatter fields other than `factory_context` do not add
dependencies. Review that explicit graph before treating a manifest as sufficient
implementation context. This resolver does not claim full Obsidian semantics.

References support whole Markdown notes, optional `.md` and display aliases.
Vault-relative paths are exact and case-sensitive. A bare name first resolves an
exact note at the vault root, then a unique basename anywhere within that vault.
Multiple basename matches require an explicit path. Headings, block references,
embeds, attachments, traversal, absolute paths and URI targets are unsupported
and fail when provided as the requirement or a declared dependency. Note names
with a dotted final segment are outside this first subset. Symlinks and
submodules cannot supply note content. Cycles are deduplicated.

Reads use committed Git blob objects, never the mutable working tree. Replacement
objects and automatic partial-clone object fetching are disabled. Git calls have
a 10-second timeout and bounded output. The repository tree is limited to 10,000
entries / 4 MiB of listing output; context to 32 files, 8 dependency edges of
depth, 512 KiB per note and 2 MiB total. Notes must be valid UTF-8; duplicate YAML
keys and excessive aliases fail validation. Dependency notes need not be ready;
the root requirement requires a feature ID, title and 1–100 acceptance criteria
for local preview. Bound task intake accepts at most 30 criteria to match the
task contract; it rejects larger requirements rather than truncating them. Titles
and criteria are trimmed, while committed file bytes remain unchanged. Resolved
file paths are limited to 2,000 characters. The final serialized manifest,
including metadata and its digest, is limited to 4 MiB: JSON escaping can reach
this limit before the raw-content budget is exhausted.

The manifest records schema/resolver versions, project, canonical local repository
path, exact commit, vault root, requirement readiness data, resolved files, blob
IDs, SHA-256 digests, sizes, content and dependency paths. Its final `sha256` hashes
UTF-8 `JSON.stringify` of the preceding manifest fields in their emitted order,
without the `sha256` field. The output has no timestamp and is deterministic for
the same inputs. Repository identity is the operator's canonical local path,
not a verified remote Git-host identity. Preserve the JSON as a reviewed artifact;
a different commit produces a separate manifest, never an update to an active
attempt's specification.

The manifest contains source text marked `untrusted_source`. Treat it as project
content, never as permission to alter tool policy, run commands or disclose
credentials. It may contain repository-private content: it is an operator output,
not a telemetry payload. Verified iteration-PR targets, project/user permission
models and live provider execution remain outside this implemented P0-01 subset.

## Server-owned binding and intake

Configure all three context flags together when starting a line. The project's
identity and repository binding are server-owned; intake cannot override them.

```sh
node src/orchestrator/dist/orchestrator/cli.js serve \
  --db ./line.sqlite --project demo \
  --context-repo /path/to/project-repository \
  --context-commit FULL_LOWERCASE_COMMIT_OBJECT_ID \
  --context-vault-root docs

node src/orchestrator/dist/orchestrator/cli.js task create \
  --project demo --wikilink '[[Features/Customer portal]]' --key portal-001
```

Supply distinct admin and enrollment credentials using the existing server
credential environment variables; clients use the admin credential. A bound
server accepts only `project`, `requirementRef`, and optional `provider` and
`priority` for new tasks. It derives title and criteria from the ready committed
requirement. Manual fields, caller-supplied context/source, missing notes, unsafe references
and requirements that are not ready are rejected by this minimal intake route.
An [explicit pinned iteration import](../how-to/pinned-iteration-import.md) uses a separate
endpoint that validates source metadata against the same server-owned commit.
Legacy iteration import remains available on unbound lines.

At most two resolutions run concurrently per server. Excess intake receives an
unavailable response and can retry. A single eight-second deadline covers the
whole resolution; shutdown cancels admission and pending responses. Git child
processes are killed on cancellation. If a filesystem read cannot be cancelled,
its reservation remains occupied until it settles, but a late result cannot
create a task after timeout or shutdown.

Task, original normalized request digest, manifest and submitted event commit
atomically. Reusing the same key and request returns the first committed task,
even after the configured commit changes or the repository becomes unavailable.
A changed request with the same key conflicts. Updating a server binding affects
only new keys; it never rewrites existing manifests or assignment context.
Concurrent retries likewise converge on the first transaction that commits.

Schema version 4 adds immutable persisted context and migrates existing mock
records without inventing manifests. Earlier binaries reject this newer schema;
back up the database before upgrading if rollback is required.

## Worker delivery and evidence

Task lists and assignments contain only an optional `context` reference with
`sha256`, `commit`, `featureId` and `path`. The full manifest is available through
admin `GET /v1/tasks/:id/context` or `task context --id TASK_ID`. These responses
contain repository paths and source text and must be handled as private content.
The JSON document survives restart and does not depend on repository availability.
An unbound task has no context and this endpoint returns not found.

Worker `GET /v1/worker/tasks/:id/context?lease=LEASE&attempt=N` requires that
worker's current credential, current project binding, and an exact persisted
assignment to that task, lease and attempt. Historical assignment reads support
audit and are side-effect free. They do not renew a lease or permit execution.
Workers heartbeat the current assignment before fetching context, verify the
manifest and file digests plus task metadata, and abort before the mock adapter
when verification fails. Replaying already recorded terminal evidence preserves
its original assignment pin without fetching replacement context.

Snapshots carry the assigned context digest, feature ID and commit; the server
rejects provenance mismatches. The digest identifies the assigned input even
when retrieval fails and a failed mock attempt is recorded. It is not proof of
provider execution. Source contents and canonical local repository paths are
excluded from task summaries and snapshot telemetry.
