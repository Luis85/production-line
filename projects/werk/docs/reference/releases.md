# Release artifacts and verification

Version 0.1.0 is packaged as `werk-0.1.0.tar.gz` and `werk-0.1.0.zip`. Each archive
has one top directory, `werk-0.1.0/`. Obtain it and `SHA256SUMS` from a delivery
source you trust. Checksums detect corruption or mismatch; an unsigned checksum
file does not independently authenticate its publisher.

## Verify before extraction

Compare the SHA-256 of your chosen archive with its exact entry in `SHA256SUMS`.
For example, Linux provides `sha256sum werk-0.1.0.tar.gz`, macOS provides
`shasum -a 256 werk-0.1.0.tar.gz`, and PowerShell provides
`Get-FileHash ./werk-0.1.0.zip -Algorithm SHA256`. A mismatch means stop and obtain
the correct artifact. Extract into a new directory; do not overwrite a running
installation or its state.

The release includes the [example system definition](../../examples/system.yaml)
and [system tutorial](../tutorials/system-from-yaml.md) for one-file native/Docker
Factory deployment. The [infrastructure renderer](infrastructure.md) can prepare
Ubuntu 24.04 cloud-init for a native VM using explicit artifact URLs and hashes.
It neither publishes a release nor creates a VM; no Werk release has been
published yet. Use the qualification evidence for the exact candidate, described below, rather than treating a rendered file as proof of a successful VM boot.

## Contents

The root contains `werk.mjs`, the Docker shell/PowerShell launchers, release
Compose/image definitions (including the Windows named-volume overlay), runtime support scripts, prebuilt application `dist`
trees, release documentation and `release-manifest.json`. The distribution
contains no user state, credentials, provider login, imported source ZIP or npm
development environment. Native use requires Node 24; Docker use requires
Docker/Compose and a shell. Neither path requires building the source project.

`release-manifest.json` records `schemaVersion`, `version`, required Node version,
`sourceCommit` (null when no repository revision is available), and an inventory of file `path`, byte count, SHA-256 and mode.
`SHA256SUMS` is a sidecar covering the two archives. Keep the manifest and checksum
record with deployment evidence. Source revision and passing package checks do
not establish live-provider or production deployment qualification.

There is no automatic update command. Follow [upgrade and backup](../how-to/upgrade-backup.md).
The complete distribution is the unit of installation; do not copy only a CLI
file and discard its shared code, dependencies, assets or runtime helpers.

## Maintainer build contract

In the source checkout only, `npm run release:build` builds the applications and
packages them. `npm run release:package` packages already-built distributions.
Use the source project's checks and fresh-extraction smoke tests before publishing.
These commands are not required or available as an installation step in the lean
release. Platform/runtime claims must match the checks actually performed for
that artifact.


## Candidate qualification gates

The release workflow builds one candidate and passes those exact archives to all
installation jobs. Publication requires every gate:

| Gate | Environment and acceptance |
| --- | --- |
| Native | Linux, macOS and Windows; checksum verification and fresh extraction, first simulated task, isolated multi-line system, graceful stop and persistent restart |
| Docker | Linux; single-line and whole-system launchers without host Node on the launcher PATH, readiness, simulated tasks and persistent restart |
| Cloud-init | Ubuntu 24.04 x86_64 VM under QEMU; actual cloud-init boot, authenticated readiness, non-root service, private state, read-only release, loopback listeners, guide page, simulated task evidence and systemd stop/restart |

A configured matrix is not evidence that its jobs passed. Review the successful
checks for the candidate's commit and the `werk-vm-qualification` artifact. The
VM report records the Werk, Node and Ubuntu image hashes, the accelerator used,
and acceptance results. An arm64 image and Windows/macOS Docker are not covered
by the VM/Linux Docker gates.

Maintainers can run the VM gate on a disposable Linux machine after installing
QEMU, `cloud-localds`, OpenSSH, OpenSSL, curl and `nc` (netcat):

```text
node scripts/release/extract.mjs release /tmp/werk-candidate
node scripts/release/cloud-init-smoke.mjs --root /tmp/werk-candidate/werk-0.1.0 --archives release
```

The gate downloads the official Ubuntu Noble cloud image and checks its digest
against the official HTTPS checksum manifest; a changed image is recorded in the
report. Node 24.19.0 is pinned by archive digest. It uses KVM when available or
software emulation otherwise. The guest downloads the candidate through an HTTPS
fixture with an explicitly trusted ephemeral certificate; production TLS checks
remain enabled. SSH verifies a generated host public key. Fixture keys, guest
state and user-data are deleted during teardown and are not uploaded as evidence.
The harness opens SSH only on host loopback, uses a private QEMU guest network,
and never requests provider credentials or creates a cloud account resource.
