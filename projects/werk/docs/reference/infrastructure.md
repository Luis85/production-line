# Infrastructure renderer

The portable IaaS profile emits cloud-init for **Ubuntu 24.04 Linux**, running a
native mock Werk system under systemd. It supports x86_64 and arm64 VM images.
There is no provider SDK, cloud resource creation, Docker VM profile or automatic
upgrade/restore operation. Rendering supports both architectures; the required
[release qualification gate](releases.md#candidate-qualification-gates) boots an
x86_64 Ubuntu VM. Only a passing gate establishes boot qualification for its
exact candidate; arm64 boot coverage remains outstanding.

No Werk release is currently published. Real provisioning requires an accessible,
trusted versioned Werk archive and a matching verified hash; example placeholders
are not a distribution source.

## CLI contract

```text
node werk.mjs infrastructure validate|render --file SYSTEM_YAML --release-version VERSION --release-url HTTPS_URL --release-sha256 SHA256 --node-url NODE_HTTPS_URL --node-sha256 SHA256 --architecture x86_64|arm64 [--json]
```

| Input | Meaning |
| --- | --- |
| `--file` | Existing bounded [system YAML](system-definition.md); environment must be `native`, every port at least 1024 |
| `--release-version` | Exact stable numeric `major.minor.patch` matching the archive path |
| `--release-url` | HTTPS URL ending in `/vVERSION/werk-VERSION.tar.gz` or `/VERSION/werk-VERSION.tar.gz`; no URL credentials, query, fragment, custom port or encoded path |
| `--release-sha256` | Exact SHA-256 for the Werk archive |
| `--node-url` | Official `https://nodejs.org/dist/v24.X.Y/node-v24.X.Y-linux-x64.tar.xz` or matching `linux-arm64` URL |
| `--node-sha256` | Exact SHA-256 for that Node archive |
| `--architecture` | `x86_64` maps to Node `x64`; `arm64` maps to Node `arm64` |
| `--json` | Structured output rather than raw cloud-config for render |

`validate` returns `{ok, profile, plan}`. `render --json` adds `cloudConfig` to that
object. Plain `render` emits cloud-config on stdout for explicit redirection by
the caller. Both actions read local inputs and produce output only: they do not
fetch artifacts, create runtime state, contact a provider or write output files.
Success exits 0; rejected input/read failures exit 2. With `--json`, failures return
`{ok:false,error:{code:"INVALID_INFRASTRUCTURE_INPUT",message}}`; otherwise diagnostics
use stderr. Check exit status and errors before accepting output. Validation cannot establish
URL reachability, publisher authenticity or VM readiness.

## Generated installation layout

| Path or resource | Ownership / purpose |
| --- | --- |
| `/opt/werk/releases/VERSION` | Versioned root-owned application files, read-only to the service user |
| `/opt/werk/node/v24.X.Y` | Pinned Node runtime; only `bin/node` and `LICENSE` are installed, not npm |
| `/etc/werk/system.yaml` | Nonsecret reviewed topology |
| `/etc/werk/runtime.env` | Nonsecret deployment environment defaults |
| `/var/lib/werk` | Private persistent system state owned by `werk` |
| `werk` system user/group | Non-root runtime identity |
| `werk-system.service` | Foreground system supervisor managed by systemd |

The environment file sets `WERK_STATE_DIR=/var/lib/werk`,
`WERK_SYSTEM_FILE=/etc/werk/system.yaml`, and `WERK_LOG_OUTPUT=stream`.
See [configuration](configuration.md) for precedence. Setup generates distinct
Factory/line credentials locally in private state before the service is enabled
and started. No credentials are embedded in user-data, artifact URLs or logs.

Cloud-init installs host packages `ca-certificates`, `curl`, `git`, `python3` and
`xz-utils`; this needs the configured Ubuntu package repositories. Artifact
installation requires outbound HTTPS. The profile verifies each archive's SHA-256
before extraction, bounds archive members/bytes, rejects unsafe paths and
links/special files in the Werk payload, and verifies the Werk release manifest.
Only the regular Node executable/license are extracted; unused npm links create
no filesystem objects. Limits are 300 MiB downloaded per artifact, 10,000 archive
entries, 256 MiB total Werk payload and 512 MiB total Node archive member bytes.
Werk members are bounded to 32 MiB each, Node members to 256 MiB. The installer
also checks the actual Node executable version before installation. It does not run npm,
compile application source or install provider credentials. Host package updates
are not locked by the Werk/Node archive hashes.

The services bind loopback. Access them through SSH forwarding and separately
configured SSH authentication; the renderer does not configure a public TLS
endpoint, firewall policy or provider security group. Runtime structured logs
stream to journald. Host retention, export, alerting and backup policies remain
operator-managed.

## Lifecycle and state boundaries

Cloud-init explicitly creates the `werk` group and defers configuration writes
until the account/group exist. The provisioning step runs setup before
`systemctl enable --now werk-system.service`, then polls authenticated system
doctor for up to 120 seconds. Success requires both `ok: true` and
`state: running`, not a stopped system's successful preflight. On readiness failure
it attempts to stop the service (200-second command bound), fails provisioning and
preserves installation/state for inspection. Verify the service is stopped before
recovery; no state or versioned directories are automatically deleted.

The service uses `Restart=on-failure`, a 10-second restart delay and a limit of
three starts per 300 seconds. `RequiresMountsFor=/var/lib/werk` orders startup
after configured state-path mounts; operators still need to configure the intended
persistent mount and prevent an absent volume from becoming fresh local state.
`KillMode=mixed` and a 180-second stop timeout allow
the supervisor to stop children before systemd enforces termination. This is not
a guarantee that a task finishes within that deadline. The unit enables private
temporary storage, restrictive umask, no new privileges and read-only system/home
boundaries; `/var/lib/werk` is its writable application state.

The service runs native foreground start without opening a
browser. Its readiness is stronger than process creation: inspect the operator's
status/doctor and service diagnostics. State is separate from release files, but
it remains SQLite databases and durable worker journals, requiring a single active
owner and consistent stopped-state backups.

The installer refuses an existing versioned release or Node destination. Cloud-init
is initial installation input, not an idempotent rerun/repair mechanism. An
interrupted install requires inspection and deliberate recovery, preserving any
state already created. A dedicated mounted state location must be empty: a raw
filesystem root containing `lost+found` is rejected. Bind an empty dedicated
subdirectory instead and manage mount ordering separately. Re-rendering is not a safe in-place
upgrade or rollback. Keep credentials out of metadata, preserve the exact artifact
hashes, and follow [VM operations](../how-to/operate-linux-vm.md) for deliberate
replacement and restoration. The [twelve-factor explanation](../explanation/twelve-factor.md)
describes remaining statefulness and availability gaps.
