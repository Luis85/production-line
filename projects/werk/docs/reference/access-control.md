# Access control and mutation auditing

Werk supports named bearer-token principals for one Factory or one production
line. This is service-scoped token authorization, not an identity provider,
SSO, per-project tenancy or an enterprise audit ledger.

| Role | Read service APIs | Mutate tasks or registry | Manage credentials |
| --- | --- | --- | --- |
| Viewer | Yes, including task context and evidence metadata | No; HTTP 403 | No |
| Operator | Yes | Yes | No |
| Legacy admin | Yes | Yes | Private filesystem administration only |

Tokens do not grant access to other services. The legacy admin token remains
available for bootstrap, Factory-to-line polling and recovery. Named tokens
must differ from legacy admin, enrollment and configured line credentials.
Worker identity and enrollment tokens retain their separate protocol authority.
A human operator cannot enroll a worker with an operator token.

## Configuration

The optional private `access.json` file lives beside a service's credentials:
`.werk/access.json`, system-state `factory/access.json`, or
`lines/LINE_ID/access.json`. Use the security CLI to generate credentials; do not
paste token values into YAML, shell arguments or documentation. Its schema is:

```json
{
  "schemaVersion": 1,
  "principals": [
    {"id": "observer", "role": "viewer", "token": "REPLACE_WITH_A_PRIVATE_RANDOM_TOKEN"}
  ]
}
```

The shown string is a placeholder, never a usable deployment credential.
There are at most 32 principals, with distinct IDs and tokens. IDs match
`[a-z][a-z0-9_-]{0,62}`; `legacy-admin` is reserved. Tokens contain 24–256 ASCII
letters, digits or `._~-`; generated tokens use 32 random bytes encoded as hex.
Unknown fields, malformed UTF-8, duplicate IDs/tokens, symbolic links, special
files and files over 64 KiB fail startup. POSIX files must be private (0600).
Windows permissions inherit the directory ACL; protect that directory explicitly.

Packaged launchers tolerate an absent optional access file. They reject an
existing invalid file. Standalone service CLIs accept `WERK_ACCESS_FILE` with a
required explicit path. Services take a snapshot at startup: edits, revocation
and rotation become effective only after restart. Already-entered browser
tokens are not rewritten; users must sign in again when their token changes.

`GET /v1/access` returns `{principal:{id,role},permissions:{read:true,write:boolean}}`.
The same `access` metadata is included in `/v1/overview` and Factory
`/v1/factories`. No token is returned. Viewer reads include `/v1/monitoring` and
`/metrics`. Public UI documents, `/guide` and liveness remain public; API data
requires credentials. A viewer may inspect source context: only grant that role
to people entitled to read the whole service's data.

## Security CLI

`node werk.mjs security access ACTION --state-dir SERVICE_STATE [options] [--json]`

| Action | Additional options | Effect |
| --- | --- | --- |
| `list` | None | List principal IDs/roles without tokens |
| `grant` | `--id NAME --role operator\|viewer` | Create a named random credential |
| `rotate` | `--id NAME` | Replace one existing named token |
| `revoke` | `--id NAME` | Remove one principal |
| `rollback` | None | Restore the previous complete named-principal set |

Mutations hold an exclusive `access.lock`, write private temporary files and
atomically replace `access.json`. The immediately previous set is retained in
`access.previous.json`; it contains secrets and must remain protected. A
successful mutation reports `restartRequired: true`, paths and a next step,
never token values. The legacy credential file remains unchanged. Do not use
rollback after a credential compromise: it can reactivate revoked tokens.
A process killed during a change can leave `access.lock`; establish that its
owner has exited before removing that lock. There is no automatic stale-lock
recovery or rollback of a running service.

## Audit record

Authenticated human/API mutation attempts emit `mutation_audit` JSON records
through the existing service log stream. Each contains schemaVersion, UTC time,
service, level, generated requestId, actor ID, role, normalized action, HTTP
status and outcome (`succeeded`, `denied`, `failed` or `interrupted`). Actions use
fixed routes, replacing registry entity IDs with `:id`. Unknown routes are
`unmatched`. Headers, tokens, query values, bodies, task content, entity IDs and
exception text are excluded. Viewer-denied mutations are recorded. Worker
protocol operations retain their task-event history; this audit stream covers
the human/operator boundary. Authentication failures have no trusted actor and
appear in ordinary request diagnostics.

Audit delivery is operational, best effort and bounded by the configured log
sink. A log failure must not turn a committed mutation into a false failure.
For retention and restricted access, collect stream output or container logs in
an external logging service. This implementation does not claim immutable,
exactly-once or tamper-evident audit storage.

See [manage access](../how-to/manage-access.md) and the
[security boundary](security.md).
