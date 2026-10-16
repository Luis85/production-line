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

Launchers open clean loopback URLs without tokens. Factory/orchestrator webviews
and interaction widgets retain entered tokens in page memory. The worker exchanges
its token for a separate HttpOnly browser session and discards the entered token. Read credentials privately and keep values out of prompts,
stdout, shell history, source control and screenshots. Protect state and backups:
they contain credentials, task content and potentially repository evidence.
POSIX state directories/files use 0700/0600. Native Windows inherits ACLs; apply
access for the operating account explicitly. Docker PowerShell exports have a
separate current-user-only ACL procedure. Platform qualification evidence is
reported separately; Linux checks do not establish Windows ACL behavior.

Worker basic status, health and metrics remain read-only without a login. The
Vue worker webview requires its separate private `webview-token` for history,
environment details and chat. Browser sessions expire after 12 hours and are
revoked on logout or worker restart. Cookie-authenticated API requests require
a webview header; mutations also require the same Origin. Durable operator tokens
never enter cookies, URLs or browser storage. Cookies share hostname scope across
ports, so use trusted local services or separate hostnames. Automation retains
bearer authentication. See [worker webview](../how-to/use-worker-webview.md). Retain trusted
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

## Local model tool grants

Local model tools are disabled by default. An authenticated worker operator can
grant task-worktree file access, fixed command presets, CLI tools, web origins
and individual MCP tools through **Settings → Tools & MCP** or the authenticated
`tool-access` commands. Tool results are sent to the selected
model provider. Commands and MCP servers run with their configured account or
remote-service authority; a Git worktree does not contain their side effects.
File inspection remains read-only. New implementation requests additionally require
explicit approved paths and enabled required verification presets; their candidate
tools can change only those paths in the owned worktree. Current grants, original
Git ownership, expected content hashes and persisted check evidence are revalidated.
The review artifact comes from actual candidate contents; a later edit invalidates
verification. Neither a model summary nor an MCP annotation establishes a passing check.
CLI tools accept model arguments only after an allowlist of one- or two-word
commands, standalone required flags, refused options and path checks; they run
without a shell, in the task worktree, with bounded time and output. The policy
rejects model-supplied response files and ambiguous required-flag forms, but cannot
prove the meaning of an unknown CLI grammar or detect option abbreviations,
configuration files or symlinks a CLI reads itself.
Private MCP credentials stay in worker state, outside the public tool manifest.
Tool output and repository content cannot authorize changes to grants. See
[manage model tools](../how-to/manage-model-tools.md) for saving, revocation and
the separate authority of orchestrator execution.

## Threat model and limitations

The trusted computing base includes the host account owning state, operators
allowed to submit work, installed provider tools, and deployment administrators.
A person who can rewrite credential files has control of that service. Viewer
restrictions defend the HTTP mutation boundary, not malicious local filesystem
access. A stolen bearer token grants its role until rotation/revocation and
restart. Factory/orchestrator webviews and automation clients supply an explicit
Authorization header. The worker webview uses the separate HttpOnly session
described above. Do not add permissive cross-origin policy.

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
