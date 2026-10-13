# Durable Factory mutation retries

Factory schema 2 persists successful mutation receipts in the same SQLite transaction as the registry change. Supply `Idempotency-Key` over HTTP, `--key` to the Factory CLI, or the required `idempotencyKey` to an enabled Factory MCP mutation. Requests without a key keep their existing behavior. Mock scheduling and provider execution are unchanged.

## Key and replay contract

A key has 1–128 characters from `A–Z`, `a–z`, digits, `.`, `_`, `:`, and `-`. Empty, invalid or repeated HTTP key headers fail with 400. Keys are case-sensitive and share one namespace across all six factory/line create, update and delete operations in one registry database. Every retry must still authenticate using the current Factory admin credential; keys are not authorization.

Generate a fresh random key for each intended change. Retain that key and input when a connection fails, a response is lost or a process restarts. A successful retry returns the original committed JSON result and status: 201 for create, 200 for update/delete. It does not execute the mutation again. Reusing a successful key with a different operation, target or normalized payload returns 409. Validation failures and failed transactions do not reserve a key.

The original response remains the replay result even if the resource was renamed, moved, deleted or recreated with the same ID. Replaying a create does not recreate a deleted registration; replaying a delete does not delete its replacement. Use a normal GET to inspect current state. Credential configuration changes do not prevent replay of an already committed line mutation; new registration or credential-reference changes still validate the current configuration.

## Normalized intent

Receipt format 1 hashes the operation, target and normalized payload with sorted object keys. Creates reuse the public validators: trimmed names, normalized IDs/URLs and default parent values. Generated resource IDs are response values, not part of the request digest. Equivalent JSON property order, default parent omission and canonical URL spelling therefore replay the same create.

For PATCH, only explicitly supplied fields enter the digest; their normalization is independent of the live record. An omitted field differs from an explicitly supplied field, even if that field currently has the supplied value. For example, `{ "name": "New" }` and `{ "name": "New", "parentId": null }` require different keys. This prevents a retry from changing identity after another client edits the record. A delete has its operation and target plus a null payload; it takes no request payload.

## Persistence and operations

Opening an existing schema-1 registry migrates it transactionally to schema 2 while preserving factories and lines. `BEGIN IMMEDIATE` encloses receipt lookup, resource mutation and receipt insertion; independent writers cannot commit the same key twice. A failed receipt insert rolls back the resource change. Registries with a newer schema are rejected.

Receipts contain only key/request digests, original response status and the public response JSON. They do not store the raw key, authorization header, request body or environment credential values. Line responses contain the configured credential **reference name**, such as `WERK_LINE_ALPHA_TOKEN`. Names and URLs are public registry metadata; avoid putting secrets in those fields.

Receipts have no TTL or automatic eviction and remain valid after deletion of their original resource. Database triggers reject receipt UPDATE/DELETE. Disk usage grows with successful distinct keyed mutations; include receipts in the normal database backup and restore procedure. Replacing a registry with a fresh database creates a new key scope; restoring an older backup restores only the receipts present in that backup. Do not prune receipts to reclaim space while promising indefinite retry semantics.

## CLI example

```sh
# Prepare factory.json with the ordinary Factory create fields.
werk-factory factory create --file factory.json --key factory-create-2026-01
# Retry the exact intent with the same key after a lost response.
werk-factory factory create --file factory.json --key factory-create-2026-01
werk-factory factory delete --id products --key factory-delete-2026-01
```

The CLI accepts `--key` only on create, update and delete. The authenticated browser UI retains a key for an uncertain mutation retry and replaces it for a new intent. Factory MCP writes require explicit enablement and an explicit stable key.

## Verification

[Factory mutation regressions](../../tests/factory/factory-idempotency.test.mjs) exercise all six operations, normalized input, changed intent, generated IDs, post-delete replay and ID reuse, receipt-write rollback, schema migration, independent concurrent processes, dropped HTTP responses, server restart, duplicate headers, legacy clients and real CLI retries. [MCP regressions](../../tests/shared/mcp/docker-agent-mcp.test.mjs) cover packaged stdio requests and persistent Factory replay across restart. The tests use mock registries and local HTTP; they do not demonstrate live provider execution.
