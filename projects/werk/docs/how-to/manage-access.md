# Manage access and TLS ingress

Start with a working local runtime and a protected backup. Keep services bound
to loopback. Private SSH tunnels remain the default remote-access path; public
TLS ingress is a separate, explicit deployment choice.

## Give a person read-only access

Run this from the extracted native release, using the service state directory:

```sh
node werk.mjs security access grant --state-dir /srv/werk/state/factory --id observer --role viewer --json
node werk.mjs security access list --state-dir /srv/werk/state/factory --json
```

For a single line, use its `.werk` directory. For a system line, use
`/srv/werk/state/lines/LINE_ID`. Read the generated token privately from that
service's `access.json` and deliver it through your approved secret channel.
Restart the owning runtime, sign in, and confirm the webview identifies viewer
access. Reads should succeed; task submission and registry mutation must return
403. Use a separate `operator` principal when writes are needed.

Docker deployments can run the same command inside their existing release
image without installing host Node. On Linux with a bind-mounted service state:

```sh
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user "$(id -u):$(id -g)" \
  --mount type=bind,source=/srv/werk/state/factory,target=/state \
  --entrypoint node YOUR_EXISTING_WERK_IMAGE \
  /app/werk.mjs security access grant --state-dir /state --id observer --role viewer --json
```

Use the exact image selected by your installation. For Docker Desktop, mount
its existing, ownership-verified named volume and select the service subdirectory
under `/state`. Do not create a replacement volume or copy exported credentials
back over live state. Stop/start the existing Docker deployment after the edit.

## Rotate or revoke a named token

1. Keep a working legacy admin credential in an approved secret store.
2. Run `node werk.mjs security access rotate --state-dir SERVICE_STATE --id NAME --json`.
   To remove access instead, use `revoke`.
3. Deliver the new token privately, stop and restart the owning runtime, and sign
   in with the replacement. Confirm the old token now returns 401.
4. Secure or remove the previous-token rollback file according to your retention
   policy. It must never become an automatic recovery source after compromise.

Until restart, the old token still works and the replacement does not. For an
urgent revocation, stop the runtime before editing and keep it stopped until the
replacement configuration is verified. For an accidental configuration change,
`security access rollback` restores the previous set; restart and verify again.
Rollback preserves legacy admin authority but can reactivate removed users.

## Rotate bootstrap admin or enrollment credentials

These are service integration secrets, separate from named user tokens. The
named-access CLI intentionally leaves them unchanged. Rotation requires a
coordinated maintenance window:

1. Stop the whole owning runtime/system and confirm all processes or containers
   are stopped. Take a private full-state backup. Do not edit a running service's
   database or identity files.
2. Generate a new 32-byte random secret using an approved local secret tool.
   Replace only the chosen field in private `credentials.json`, retaining the
   other fields, 0600 mode and distinct credentials. Never expose values in shell
   arguments, stdout, repository files or screenshots.
3. For Factory admin, replace `WERK_FACTORY_ADMIN_TOKEN` in `factory/credentials.json`.
   For line admin, replace `WERK_ADMIN_TOKEN` in that line's file. Native system
   startup derives Factory polling credentials from those line files. A
   standalone Factory must also update its corresponding `WERK_LINE_*_TOKEN`.
   Docker systems additionally have a private
   `factory-input/lines/LINE_ID/credentials.json` copy: update its same field.
4. For enrollment, replace `WERK_ENROLLMENT_TOKEN` and each Docker worker's
   `enrollmentToken` in its private `workers/worker-N/enrollment.json`. Docker
   system Factory input copies must match the updated line credentials too.
   Preserve every worker identity, token and journal; already-enrolled workers
   authenticate independently and must not be deleted or re-enrolled.
5. Restart, run doctor, verify Factory polling and every worker, and confirm
   old administrative/enrollment authority is rejected. Existing worker identity
   tokens are unaffected by rotating enrollment; this is not worker revocation.
6. If validation fails, stop again and restore the coordinated credential files
   from the backup. Preserve state and retain evidence of the failed rotation.

This is an explicit offline procedure, not an automatic integration-secret
rotation command. A compromised worker requires separate containment and
review; enrollment rotation alone does not invalidate its issued token.

## Put one webview behind TLS

First qualify local startup and role restrictions. Install a supported Caddy
release on the same host through your managed package channel. Ensure DNS points
to that host and explicitly allow TCP 80/443 for certificate issuance and HTTPS.
Do not open Factory, line or worker backend ports at the firewall.

```sh
node werk.mjs security ingress --hostname factory.example.com --port 3100 > factory.Caddyfile
caddy validate --config factory.Caddyfile --adapter caddyfile
```

Review and install the generated configuration using your existing Caddy service
procedure. It targets only `127.0.0.1`, enables managed TLS and security headers,
limits request bodies, and blocks worker execution/enrollment APIs, worker
status, liveness and Prometheus at the public edge. Use a separate hostname and
stanza for each orchestrator. Configure Factory's upstream registry URLs for
internal service-to-service access; do not send workers through the public edge.
Before first system setup, declare each line's public browser origin:

```yaml
orchestrator:
  port: 3001
  webviewUrl: https://alpha.example.com/
```

The Factory then links to that HTTPS webview while polling the internal API.
The URL is browser navigation only and does not change worker or Factory network
traffic. Existing systems reject definition drift; configure a coordinated
stopped migration rather than changing the registry behind the saved definition.

Test HTTPS with a viewer token and an operator token. Verify that worker routes
return 404 from the edge, viewer mutations return 403, credentials never appear
in URLs, and backend ports remain inaccessible from another host. Access to the
public login page is not access to service data. Caddy does not add SSO or replace
Werk's bearer authorization. Keep upstream HTTP strictly on the same trusted
host; use a separately reviewed TLS/mTLS design for cross-host transports.

No network endpoint, DNS record, certificate or firewall rule is created by the
Werk ingress command. Public deployment also needs managed rate limiting,
secret delivery, monitoring and an incident-response process appropriate to the
operator's environment. See [access contracts](../reference/access-control.md).
