# Release artifacts and verification

Version 0.9.0 is packaged as `werk-0.9.0.tar.gz` and `werk-0.9.0.zip`. Each archive
has one top directory, `werk-0.9.0/`. Obtain it and `SHA256SUMS` from a delivery
source you trust. Checksums detect corruption or mismatch; an unsigned checksum
file does not independently authenticate its publisher.

## Download and start in one command

With Node.js 24, curl and tar on PATH, run in your chosen installation directory:

```sh
curl -fsSL https://github.com/Luis85/production-line/releases/latest/download/install.mjs -o werk-install.mjs && node werk-install.mjs
```

In Windows PowerShell:

```powershell
curl.exe -fsSL https://github.com/Luis85/production-line/releases/latest/download/install.mjs -o werk-install.mjs; if ($LASTEXITCODE -eq 0) { node werk-install.mjs }
```

The installer is executable code from this repository's GitHub release. Review it before running if needed. It contains the exact version and tar.gz SHA-256 from the candidate build; all subsequent downloads use that immutable version URL. No GitHub API token is required for public release assets. A missing release (404), failed download, wrong checksum or invalid extracted inventory fails before startup. Downloaded bytes and extraction are staged in a temporary directory and removed on failure. An existing `werk-<version>` directory is refused, preserving its files and state.

| Installer option | Behavior |
| --- | --- |
| `--directory PATH` | Parent installation directory; defaults to the current directory |
| `--no-start` | Verify and install without starting services |
| `--no-open` | Start without opening a browser |
| `--file PATH` | Start using your system YAML instead of the packaged example |
| `--state-dir PATH` | Explicit persistent state directory for startup |
| `--help` | Print options without downloading |

For a specific version or prerelease, download `install.mjs` from `/releases/download/v<version>/install.mjs`. Prereleases are excluded from the stable `latest` download. The one-command native path requires tar (provided by current Windows/macOS and most Linux installations); curl is only needed for the initial installer download. Docker-only users can manually download either archive and use its existing Docker launchers without host Node.

After manual extraction or installation, run `node werk.mjs up` from the installed directory. This is shorthand for `node werk.mjs system up --file examples/system.yaml`, resolving the default YAML relative to the installed launcher. `--file` or `WERK_SYSTEM_FILE` overrides that default; existing system options still apply. State defaults to `.werk-system/demo-system/` inside that version, including private Factory and per-line credentials. Startup opens the Factory after health checks; Ctrl+C stops all services. Port conflicts are reported by the runtime. Installation is retained if startup fails, so correct the problem and restart locally. New downloaded releases check stable GitHub releases on subsequent native startup; see [automatic updates](updates.md) for policy, backups, recovery and one-time adoption from 0.1.0. The installer itself still creates a separate version directory; select old state explicitly when adopting it.

## Verify before extraction

Compare the SHA-256 of your chosen archive with its exact entry in `SHA256SUMS`.
For example, Linux provides `sha256sum werk-0.9.0.tar.gz`, macOS provides
`shasum -a 256 werk-0.9.0.tar.gz`, and PowerShell provides
`Get-FileHash ./werk-0.9.0.zip -Algorithm SHA256`. A mismatch means stop and obtain
the correct artifact. Extract into a new directory; do not overwrite a running
installation or its state.

The release includes the [example system definition](../../examples/system.yaml)
and [system tutorial](../tutorials/system-from-yaml.md) for one-file native/Docker
Factory deployment. The [infrastructure renderer](infrastructure.md) can prepare
Ubuntu 24.04 cloud-init for a native VM using explicit artifact URLs and hashes.
It neither publishes a release nor creates a VM. The quick-start URL becomes available only after a stable release passes all gates and is published. Use the qualification evidence for the exact candidate, described below, rather than treating a rendered file as proof of a successful VM boot.

## Contents

The root contains `werk.mjs`, the Docker shell/PowerShell launchers, release
Compose/image definitions (including the Windows named-volume overlay), runtime support scripts, prebuilt application `dist`
trees, release documentation, the maintained [CHANGELOG](../../CHANGELOG.md) and
`release-manifest.json`. The distribution
contains no user state, credentials, provider login, imported source ZIP or npm
development environment. Native use requires Node 24; Docker use requires
Docker/Compose and a shell. Neither path requires building the source project.

`release-manifest.json` records `schemaVersion`, `version`, required Node version,
`sourceCommit` (null when no repository revision is available), and an inventory of file `path`, byte count, SHA-256 and mode.
`SHA256SUMS` is a sidecar covering both archives and the standalone `install.mjs` asset. Keep the manifest and checksum
record with deployment evidence. Source revision and passing package checks do
not establish live-provider or production deployment qualification.

Native installations support [automatic updates and explicit update commands](updates.md).
For Docker, managed VMs and manual recovery, follow [upgrade and backup](../how-to/upgrade-backup.md).
The complete distribution is the unit of installation; do not copy only a CLI
file and discard its shared code, dependencies, assets or runtime helpers.

## Illustrated Storybook and storymaps

Every qualified release also provides `werk-storybook-<version>.zip` and
`STORYBOOK-SHA256SUMS`. Download both from the same release, compare the ZIP's
SHA-256 with its exact checksum entry, then extract it into a new directory.
The separate checksum file covers the visual documentation; `SHA256SUMS` remains
reserved for the runtime archives and installer.

Open `werk-storybook-<version>/storymap/index.html` for the illustrated system
journeys and component inventory. It links desktop and mobile screenshots to the
story and source element that produced them. To use the interactive Storybook,
serve the extracted directory with a local static HTTP server and open its root
`index.html`. This documentation archive is independent of the installed runtime
and contains no provider credentials or running worker state.

The embedded `storymap/qualification.json` identifies the package version, Git
commit, source digest, component coverage, screenshot count and file hashes.
Screenshots use deterministic simulation fixtures, so they establish UI coverage
and behavior, not live-provider or deployment qualification. Publication requires
all inventoried Vue elements to render in qualified stories, successful desktop
and mobile captures, and no capture errors. Packaging rejects stale source or
revision evidence, incomplete coverage, changed or unqualified output files,
unsafe paths and symlinks.

After release publication, the same qualified site is deployed to the repository's
[GitHub Pages](https://luis85.github.io/production-line/), with the illustrated map
at [/storymap/](https://luis85.github.io/production-line/storymap/). Both stable and
prerelease publications refresh the hosted site. See the
[one-time Pages setup and retry procedure](../how-to/generate-storybook.md#host-release-documentation-on-github-pages).
Pull requests and manual branch runs do not deploy. The Pages job has its own
status: a failed deployment leaves the previous site and the published release
available.

## Maintainer build contract

Maintain [CHANGELOG.md](../../CHANGELOG.md) as part of every release. During
development, curate meaningful user-facing bullets under `[Unreleased]`. Before
tagging, move the finished changes into the first dated entry,
`[<version>] - YYYY-MM-DD`, using the release date in Europe/Berlin. Update the
root package and lockfile version to match. Keep unreleased work in its own section;
do not invent historical release entries.

From the source checkout:

```sh
npm run changelog:check
npm run changelog:notes
npm run changelog:notes -- --out release/RELEASE-NOTES.md
```

The check requires a unique, dated current-version entry in the right position
with meaningful Keep a Changelog bullets. On a tagged GitHub run, the tag must
match the package version. `changelog:notes` extracts that exact entry; its
optional `--version` must still equal the package version. Fix a missing, empty,
duplicated or mismatched entry before packaging or tagging.

Install the locked browser with
`npm exec -- playwright install --with-deps chromium`, then run
`npm run release:build` to build and package the applications and qualified
Storybook. `npm run release:package` packages already-built runtime distributions,
validates the changelog before producing output, writes the candidate's
`RELEASE-NOTES.md` sidecar and includes the full changelog in both archives.
`npm run storybook:ci` rebuilds the static Storybook and captures its stories;
`npm run release:storybook` validates and packages that evidence separately.

The release workflow checks the changelog before dependency installation. Its
publication step uses the staged candidate notes and appends the existing
installation/qualification guidance, so the published release describes the same
candidate that passed the artifact gates. This does not add a separate published
asset. The notes remain a candidate sidecar consumed by publication; the full
changelog travels inside the runtime archives.

Use the source project's checks and fresh-extraction smoke tests before publishing.
These commands are not required or available as an installation step in the lean
release. Platform/runtime claims must match the checks actually performed for
that artifact.


## Candidate qualification gates

The release workflow builds one candidate and passes those exact archives to all
installation jobs. Publication requires every gate:

| Gate | Environment and acceptance |
| --- | --- |
| Storybook | Linux Chromium; source-derived component inventory, mounted-story coverage, system journeys, desktop/mobile screenshots, clean browser checks and integrity-bound documentation archive |
| Native | Linux, macOS and Windows; both archive formats verified, standalone installer download over a local HTTP fixture, checksum verification and fresh extraction, first simulated task, isolated multi-line system, graceful stop and persistent restart |
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
node scripts/release/cloud-init-smoke.mjs --root /tmp/werk-candidate/werk-0.9.0 --archives release
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

## Publish a release

The project-owned workflow is `src/infrastructure/workflows/release/release.yml`;
Forge generates `.github/workflows/werk--release.yml`. Edit the source, then run
`node bin/forge.js workflows sync` from the repository root. Pull requests and
manual branch runs qualify candidates without publishing.

1. Update `projects/werk/package.json` and its lockfile to the desired version in
   a reviewed change (for example, `0.8.0`). Merge to `main` after checks pass.
2. From a clean checkout of the merged commit, create and push its matching tag:

   ```sh
   git switch main
   git pull --ff-only origin main
   git tag -a v0.8.0 -m "Werk 0.8.0"
   git push origin v0.8.0
   ```

3. Watch **Actions → Werk release**. The tag must match `package.json`, use a
   three-part version (optionally with a prerelease suffix), and point to a
   commit contained in `main`. Build, full checks, dependency audit, native
   Linux/macOS/Windows, Docker, cloud-init VM and Storybook qualification must all pass.
4. The publishing job uses GitHub's automatic `GITHUB_TOKEN` with `contents: write`.
   No separate release secret is required. It uploads both runtime archives,
   `install.mjs`, `SHA256SUMS`, the versioned Storybook ZIP and
   `STORYBOOK-SHA256SUMS` to a draft, then publishes it. Stable versions are marked
   latest; versions such as `0.2.0-rc.1` are prereleases and never replace latest.
   Release notes include download/start commands.
5. The **Publish released Storybook to GitHub Pages** job deploys the qualified
   site after publication. Complete the one-time Pages setup linked above before
   the first tag release; the **github-pages** environment reports its URL.

The latest stable link intentionally does not change on every merge. Only tag a
stable version that should become the new latest release; use prerelease tags
for preview builds. GitHub Actions and repository policy must permit the workflow
token to create releases. Public anonymous downloads also require a public repository.

If qualification fails, inspect and fix it before creating a new version/tag.
If upload fails, the release remains a draft: rerun the failed publishing job to
complete it. A rerun refuses to modify an already published release. Do not move
published tags or replace published assets; ship a new version instead.
