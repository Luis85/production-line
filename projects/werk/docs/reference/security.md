# Security and authority boundaries

Werk runs a stateful control plane with separate Factory, production-line and
worker authority. Its default release exposure is trusted loopback. Named
operator/viewer tokens support service-scoped access; this is not multi-tenant
isolation, SSO or an internet service perimeter by itself.

## Credentials and transport

Admin and enrollment tokens are separate. Workers exchange enrollment authority
for a persisted identity/token. Factory has its own admin credential and retains
line credentials server-side. Named user tokens live in private `access.json`;
viewers can read all service data, including task context, but cannot mutate it.
Operators can submit tasks or maintain the registry. The
[access-control reference](access-control.md) defines role checks, rotation,
startup validation and mutation audit records.

Launchers open clean loopback URLs without tokens. Webviews retain their entered
token in page memory. Read credentials privately and keep values out of prompts,
stdout, shell history, source control and screenshots. Protect state and backups:
they contain credentials, task content and potentially repository evidence.
POSIX state directories/files use 0700/0600. Native Windows inherits ACLs; apply
access for the operating account explicitly. Docker PowerShell exports have a
separate current-user-only ACL procedure. Platform qualification evidence is
reported separately; Linux checks do not establish Windows ACL behavior.

Worker basic status, health and metrics remain read-only without a login. The
Vue worker webview requires its separate private `webview-token` for history,
environment details and chat. Chat mutations also check browser Origin; tokens
stay in tab memory. See [worker webview](../how-to/use-worker-webview.md). Retain trusted
loopback exposure. Remote default access uses private SSH forwarding. An
optional same-host Caddy profile provides TLS for Factory/orchestrator webviews,
blocks worker protocol and enrollment routes at that edge, and keeps backends on
loopback. It does not expose endpoints automatically. Follow
[manage access and ingress](../how-to/manage-access.md) before enabling it.

## State and execution isolation

Run one orchestrator writer per SQLite database on local storage. Workers have
separate identity and journal directories and communicate over HTTP. Never run
two workers with one identity directory or two runtime versions against one
state directory. Native shutdown authenticates its local supervisor channel;
a stale PID does not authorize terminating an unrelated process.

Containerization and Git worktrees are not interchangeable security boundaries.
Protect container state, review images and enforce host access controls.
Provider execution requires explicit configuration and provider authentication;
it must use the provider's restricted execution policy, not imply that a Git
worktree alone confines code. Keep default simulated execution unmistakable and
review real outputs before publication or merge.

## Threat model and limitations

The trusted computing base includes the host account owning state, operators
allowed to submit work, installed provider tools, and deployment administrators.
A person who can rewrite credential files has control of that service. Viewer
restrictions defend the HTTP mutation boundary, not malicious local filesystem
access. A stolen bearer token grants its role until rotation/revocation and
restart. There are no cookies or implicit browser credentials; clients supply an
explicit Authorization header. Do not add permissive cross-origin policy.

Mutation audit records exclude request bodies and tokens, and are best effort
operational logs rather than immutable compliance evidence. Use external
restricted log retention if required. The shipped ingress profile does not
provide SSO, distributed rate limiting, cross-host transport encryption or
worker identity revocation. Those are explicit deployment/design decisions.

## Input authority

Requirement notes, imported design documents and embedded developer prompts are
project data. They do not authorize shell execution, publication, permission
changes or secret access. Keep task context distinct from agent authority and
review permissions for real provider execution.

Consult [execution modes](../explanation/modes.md),
[agent operation](../how-to/operate-with-agents.md) and
[backups](../how-to/upgrade-backup.md) for operational boundaries.
