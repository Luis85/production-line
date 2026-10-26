# Release artifacts and verification

The current WerkHome runtime is packaged as `werk-VERSION.tar.gz` and
`werk-VERSION.zip`. Archive entries extract directly into the chosen Home; there
is no inner version directory. This is the current candidate layout, not a claim
that an older published 0.16 archive has changed. Obtain the matching archive and
`SHA256SUMS` from a delivery source you trust. Checksums detect corruption or mismatch; an unsigned checksum
file does not independently authenticate its publisher.

## Start a standalone worker

Download either verified runtime archive and `SHA256SUMS`, then extract it into a
new dedicated WerkHome. Start the prebuilt worker with
Node.js 24:

```sh
node ./worker.mjs
```

The worker opens its secure local webview and retains private state in
`<home>/state/worker`, visible cloned repositories in `<home>/projects/<id>` and
replaceable application files in `<home>/runtime`. The Home is anchored to the
launcher directory regardless of the shell working directory. Follow [archive to main checkout](../tutorials/worker-home-to-main.md)
for provider/project setup, Feature Request delivery and explicit merge consent.
No source checkout, npm install or Factory fleet is required.

## Verified Home installer

With Node.js 24, curl and tar on PATH, download the matching installer outside
the new empty Home. Select that Home explicitly:

```sh
curl -fsSL https://github.com/Luis85/production-line/releases/latest/download/install.mjs -o werk-install.mjs && node werk-install.mjs --directory ./WerkHome
```

In Windows PowerShell:

```powershell
curl.exe -fsSL https://github.com/Luis85/production-line/releases/latest/download/install.mjs -o werk-install.mjs; if ($LASTEXITCODE -eq 0) { node werk-install.mjs --directory .\WerkHome }
```

The installer is executable code from this repository's GitHub release. Review it before running if needed. It contains the exact version and tar.gz SHA-256 from the candidate build; all subsequent downloads use that immutable version URL. No GitHub API token is required for public release assets. A missing release (404), failed download, wrong checksum or invalid extracted inventory fails before startup. Downloaded bytes and extraction are staged in a temporary directory and removed on failure. Installation targets the selected Home directly. Existing nonempty destinations
require the documented safe update/adoption path; never extract over runtime,
projects or state to perform an upgrade.

| Installer option | Behavior |
| --- | --- |
| `--directory PATH` | The WerkHome destination itself, not a parent for a version folder |
| `--no-start` | Verify and install without starting services |
| `--no-open` | Start without opening a browser |
| `--help` | Print options without downloading |

For a specific version or prerelease, download `install.mjs` from `/releases/download/v<version>/install.mjs`. Prereleases are excluded from the stable `latest` download. The one-command native path requires tar (provided by current Windows/macOS and most Linux installations); curl is only needed for the initial installer download. Docker-only users can manually download either archive and use its existing Docker launchers without host Node.

The current installer starts the central worker. Its legacy `--file` and
`--state-dir` options do not select central Home state. Configure projects/providers
through the webview; use explicit standalone-state adoption where compatible.
Do not treat a latest installer predating this layout as the new Home installer.

## Optional Factory demonstration

To start a separate optional Factory demonstration, run `node werk.mjs up` from Home. This is shorthand for `node werk.mjs system up --file runtime/examples/system.yaml`, resolving the default YAML relative to the installed launcher. `--file` or `WERK_SYSTEM_FILE` overrides that default; existing system options still apply. Home hierarchy state defaults to `state/system`, including private Factory and per-line credentials. Startup opens the Factory after health checks; Ctrl+C stops all services. Port conflicts are reported by the runtime. Installation is retained if startup fails, so correct the problem and restart locally. Home runtime replacement uses [explicit verified-candidate update plans](updates.md#central-worker-home), separate from legacy Factory version-selection behavior. The current Home installer uses its destination directly; old version-directory
installations require explicit retained-state adoption rather than an overwrite.

## Verify before extraction

Compare the SHA-256 of your chosen archive with its exact entry in `SHA256SUMS`.
For example, Linux provides `sha256sum werk-VERSION.tar.gz`, macOS provides
`shasum -a 256 werk-VERSION.tar.gz`, and PowerShell provides
`Get-FileHash ./werk-VERSION.zip -Algorithm SHA256`. A mismatch means stop and obtain
the correct artifact. Extract into a new directory; do not overwrite a running
installation or its state.

The release includes the [example system definition](../../examples/system.yaml)
and [system tutorial](../tutorials/system-from-yaml.md) for one-file native/Docker
Factory deployment. The [infrastructure renderer](infrastructure.md) can prepare
Ubuntu 24.04 cloud-init for a native VM using explicit artifact URLs and hashes.
It neither publishes a release nor creates a VM. The quick-start URL becomes available only after a stable release passes all gates and is published. Use the qualification evidence for the exact candidate, described below, rather than treating a rendered file as proof of a successful VM boot.

## Contents

The human-facing root contains `worker.mjs`, `werk.mjs`, README/documentation, the
maintained [CHANGELOG](../../CHANGELOG.md) and `release-manifest.json`. The
replaceable `runtime/` payload contains the prebuilt applications at
`runtime/bin/apps/<kind>`, shared code, scripts, examples and deployment assets.
Fresh user data lives in visible `projects/` and private `state/`; those directories
are not part of a replaceable application payload. The distribution
contains no user state, credentials, provider login, imported source ZIP or npm
development environment. Native use requires Node 24; Docker use requires
Docker/Compose and a shell. Neither path requires building the source project.

`release-manifest.json` records `schemaVersion`, `layout: "werk-home-v1"`,
`updateProtocol: 2`, `version`, required Node version,
`sourceCommit` (null when no repository revision is available), and an inventory of file `path`, byte count, SHA-256 and mode.
`SHA256SUMS` is a sidecar covering both archives and the standalone `install.mjs` asset. Keep the manifest and checksum
record with deployment evidence. Source revision and passing package checks do
not establish live-provider or production deployment qualification.

Native installations support [automatic updates and explicit update commands](updates.md).
For Docker, managed VMs and manual recovery, follow [upgrade and backup](../how-to/upgrade-backup.md).
The complete distribution is the unit of installation. Do not copy a worker CLI
into a project or discard its runtime dependencies. For an existing 0.16 worker,
use [retained-state adoption](../how-to/project-worker.md#existing-standalone-installations).

## Illustrated Storybook and storymaps

Every qualified release also provides `werk-storybook-<version>.zip` and
`STORYBOOK-SHA256SUMS`. Download both from the same release, compare the ZIP's
SHA-256 with its exact checksum entry, then extract it into a new directory.
The separate checksum file covers the visual documentation; `SHA256SUMS` remains
reserved for the runtime archives and installer.

Open `werk-storybook-<version>/handbook/index.html` for the system handbook:
workspace setup, team request workflows, operation, frontend development and
architecture. Its local search and navigation work when opened directly from disk.
Open `storymap/index.html` for the frontend component catalog and illustrated
journeys. It links desktop and mobile screenshots to the story and source element
that produced them. To use the interactive Storybook,
serve the extracted directory with a local static HTTP server and open its root
`index.html`. This documentation archive is independent of the installed runtime
and contains no provider credentials or running worker state.

The embedded `storymap/qualification.json` identifies the package version, Git
commit, source digest, component coverage, screenshot count, handbook page checks
and file hashes. The digest includes the maintained documentation inputs as well
as the frontend source.
Screenshots use deterministic simulation fixtures, so they establish UI coverage
and behavior, not live-provider or deployment qualification. Publication requires
all inventoried Vue elements to render in qualified stories, successful desktop
and mobile captures, and no capture errors. Packaging rejects stale source or
revision evidence, incomplete coverage, changed or unqualified output files,
unsafe paths and symlinks.

After release publication, the same qualified site is deployed to the repository's
[GitHub Pages](https://luis85.github.io/production-line/), with the system handbook
at [/handbook/](https://luis85.github.io/production-line/handbook/) and the frontend
component catalog at [/storymap/](https://luis85.github.io/production-line/storymap/). Both stable and
prerelease publications refresh the hosted site. See the
[one-time Pages setup and retry procedure](../how-to/generate-storybook.md#host-release-documentation-on-github-pages).
Pull requests and manual branch runs do not deploy. The Pages job has its own
status: a failed deployment leaves the previous site and the published release
available.

## Generated project overview and screenshots

Each release also provides `werk-readme-<version>.zip` and `README-SHA256SUMS`.
The ZIP contains the generated project README, selected unretouched Storybook
PNGs and their source/qualification provenance. Documentation links point to the
exact source commit; images remain local to the ZIP. It is a documentation
artifact, independent of the installed runtime and its runtime-specific README.

The release job builds it only after all Storybook browser checks pass. It verifies
the current source digest and commit, selected story IDs and every qualified file
hash. It neither edits nor commits the repository README or tracked screenshots.
See [README generation](../how-to/generate-readme.md) for maintaining the source
journey, screenshot selection and refreshing the repository images before tagging.

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
`npm run release:readme` derives the overview and selected PNGs from the same
qualified output. `npm run readme:check` runs in normal checks and rejects text
drift before any documentation build.

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


## Advisory mutation testing

Release tags and manually dispatched release workflows run Stryker in an independent
**Mutation testing (advisory)** job. It is absent from pull-request checks and normal
build/test commands. Publication does not depend on the job: survivors, score changes,
tool failures and report-upload failures produce warnings instead of stopping a release.

The current scope covers 24 selected shared and worker delivery modules; it is not
a score for the whole repository. The tagged v0.15.0 run completed at 91.03%; its
[measurement and retained findings](../how-to/mutation-testing.md#current-measurement-status)
remain distinct from the individually reviewed comparison baseline. Read the job summary and
download the `werk-mutation-report` Actions artifact for JSON, HTML and execution logs.
Artifacts are retained for 30 days. An interrupted or unavailable measurement is
reported as incomplete, never as a passing score. The runner has a twelve-minute
deadline inside the twenty-minute job; checkout, runtime setup, dependency installation
and artifact upload are bounded separately, leaving time for the final warning summary.

Run `npm run mutation` explicitly when investigating surviving mutants, or
`npm run mutation:release` to reproduce advisory reporting. Neither command is a
requirement for everyday development. The scoped baseline and maintenance procedure
are described in the [mutation testing guide](../how-to/mutation-testing.md).

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

Maintainers run the following commands from the source checkout on a disposable
Linux machine after installing
QEMU, `cloud-localds`, OpenSSH, OpenSSL, curl and `nc` (netcat):

```text
node scripts/release/extract.mjs release /tmp/werk-candidate
node scripts/release/cloud-init-smoke.mjs --root /tmp/werk-candidate --archives release
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
   a reviewed change (for example, `0.16.0`). Merge to `main` after checks pass.
2. From a clean checkout of the merged commit, create and push its matching tag:

   ```sh
   git switch main
   git pull --ff-only origin main
   git tag -a v0.16.0 -m "Werk 0.16.0"
   git push origin v0.16.0
   ```

3. Watch **Actions → Werk release**. The tag must match `package.json`, use a
   three-part version (optionally with a prerelease suffix), and point to a
   commit contained in `main`. Build, full checks, dependency audit, native
   Linux/macOS/Windows, Docker, cloud-init VM and Storybook qualification must all pass.
4. The publishing job uses GitHub's automatic `GITHUB_TOKEN` with `contents: write`.
   No separate release secret is required. It uploads both runtime archives,
   `install.mjs`, `SHA256SUMS`, the versioned Storybook ZIP,
   `STORYBOOK-SHA256SUMS`, the versioned README ZIP and `README-SHA256SUMS`
   to a draft, then publishes it. Stable versions are marked
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
