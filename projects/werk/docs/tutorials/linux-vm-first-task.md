# Prepare a Linux VM deployment

This tutorial prepares cloud-init for one native mock Werk system on an Ubuntu
24.04 Linux VM. It separates installation files from private persistent state and
uses SSH tunnels for browser access. It does not provision a cloud account or
claim an actual VM boot has been verified.

**No Werk release has been published yet.** You need an independently trusted,
versioned Werk `.tar.gz` URL and its exact SHA-256 before provisioning. A locally
built archive is not automatically an accessible release URL. The placeholders
below deliberately do not identify a usable release; do not submit them to a VM.

## Prepare verified inputs

Use an extracted trusted runtime with Node 24 available on your workstation.
Choose an Ubuntu 24.04 image with cloud-init and either x86_64 or arm64 architecture.
You also need your provider's ordinary VM/SSH access setup, outbound HTTPS access
for installation artifacts/packages, and permission to create that VM. Keep
Factory, orchestrator and worker ports closed to public ingress; allow SSH only
from your administrative source network.

Copy the shipped [system example](../../examples/system.yaml) to `system.yaml`.
Keep `environment: native`; customize IDs, names and nonoverlapping ports before
installation; all service ports must be at least 1024 for the non-root profile. The example uses Factory 3100, lines 3001/3002 and worker status
4201/4202. Credentials and task seeds do not belong in this YAML.

Obtain the Werk archive hash through your trusted release delivery channel.
Select an exact Node 24 Linux archive matching the VM architecture and verify its
hash from an authenticated Node distribution source. A hash supplied alongside an
untrusted download does not establish publisher identity. See
[release verification](../reference/releases.md).

## Validate and render

Replace all uppercase artifact placeholders with real reviewed values. For an
x86_64 VM, the command shape is:

```text
node werk.mjs infrastructure validate --file system.yaml --release-version 0.1.0 --release-url HTTPS_VERSIONED_WERK_TAR_GZ --release-sha256 WERK_SHA256 --node-url https://nodejs.org/dist/v24.X.Y/node-v24.X.Y-linux-x64.tar.xz --node-sha256 NODE_SHA256 --architecture x86_64 --json
```

For arm64, select the matching `linux-arm64` Node archive and `--architecture
arm64`. Validation checks the profile inputs and topology; it does not boot a VM
or prove that URLs are reachable. Inspect the returned plan.

Render the same validated inputs by replacing `validate` with `render` and
omitting `--json`; redirect stdout into a local file:

```text
node werk.mjs infrastructure render --file system.yaml --release-version 0.1.0 --release-url HTTPS_VERSIONED_WERK_TAR_GZ --release-sha256 WERK_SHA256 --node-url https://nodejs.org/dist/v24.X.Y/node-v24.X.Y-linux-x64.tar.xz --node-sha256 NODE_SHA256 --architecture x86_64 > cloud-init.yaml
```

Review the generated cloud-config before use. It contains nonsecret topology and
verified-artifact instructions, not Werk login credentials. Never put bearer
tokens, provider credentials, private SSH keys or secret download URLs in user
data. Provider metadata/user-data and cloud-init diagnostics may be retained.
The [infrastructure reference](../reference/infrastructure.md) lists the emitted
paths and installation behavior.

## Launch, then verify on the VM

Create the Ubuntu VM through your provider using the reviewed cloud-init file and
your normal SSH public-key configuration. This is a separate infrastructure
operation; the renderer does not create or bill cloud resources. Keep its output
and artifact hashes with the deployment record.

After connecting over SSH, wait for cloud-init to finish, inspect its result, then
check the Werk systemd service and journal:

```text
sudo cloud-init status --wait
sudo systemctl status werk-system.service
sudo journalctl -u werk-system.service --no-pager -n 100
```

For release 0.1.0 with your selected exact Node version, check the saved runtime as
its non-root owner (replace `v24.X.Y`):

```text
sudo -u werk /opt/werk/node/v24.X.Y/bin/node /opt/werk/releases/0.1.0/werk.mjs system status --state-dir /var/lib/werk --json
sudo -u werk /opt/werk/node/v24.X.Y/bin/node /opt/werk/releases/0.1.0/werk.mjs system doctor --state-dir /var/lib/werk --json
```

Installation success alone is not whole-system readiness; investigate a failed
service before retrying. The
[VM operations guide](../how-to/operate-linux-vm.md) describes maintenance and backup.

For the unchanged example, forward the loopback webviews from your workstation:

```text
ssh -N -L 3100:127.0.0.1:3100 -L 3001:127.0.0.1:3001 -L 3002:127.0.0.1:3002 SSH_USER@VM_HOST
```

Replace the SSH destination and use the configured ports if you changed the
example. Open `http://127.0.0.1:3100`. Factory uses its own admin credential; each
line has separate credentials. Retrieve the corresponding private credential file
at `/var/lib/werk/factory/credentials.json` for Factory and
`/var/lib/werk/lines/alpha/credentials.json` for Alpha, through your trusted
administrative SSH session, without printing it into shared
logs or putting it in a URL. Keep credentials out of shell history, prompts and
screenshots. The public `/guide` explains the model without authentication.

Follow the [system first-task steps](system-from-yaml.md) through Alpha's Intake.
Verify its configured project, submit one task, and inspect worker evidence. A
`simulated` outcome confirms the mock path; it does not mean code was generated,
published or merged. Stop and back up the system before replacing the VM or release.

The renderer and local tests are a foundation for this deployment, not evidence
of a completed cloud boot or recovery exercise. Record provider/image identity,
cloud-init outcome, readiness and a restore rehearsal for your actual deployment.
