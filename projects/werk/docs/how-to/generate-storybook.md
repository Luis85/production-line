# Generate the UI storybook and storymaps

Werk's Storybook renders the same Vue components as its separately shipped
applications. Its storymap combines a source inventory, component contracts,
workflow stories and desktop/mobile screenshots. It covers first-party Vue
components in Factory, Orchestrator, Worker, shared UI, the system guide and the
labelled concept simulation. Third-party Nuxt UI internals are not counted as
Werk components.

## Generate and inspect

From `projects/werk`, use Node 24 and the committed dependency lockfile:

```sh
npm ci
npm exec -- playwright install --with-deps chromium
npm run storybook:ci
```

The command scans source code, builds Storybook, captures every story at
1440 × 1000 and 390 × 844, and writes `storybook-static/`. It fails if a story
cannot complete, makes an unexpected network request, reports a browser error,
claims a component it never mounted, or leaves a source component uncovered.
Set `WERK_CHROMIUM` to an existing Chromium executable when necessary.

Serve `storybook-static/` with a local static HTTP server and open `/` for
interactive stories or `/storymap/` for the illustrated reference. The storymap
can also be opened directly as `storymap/index.html`; its screenshots and source
contracts work without a server. Interactive Storybook modules require HTTP.
For development, `npm run storybook` starts Storybook on port 6006.

Generated files are ignored by Git. Edit the component or story fixture, then
regenerate; do not retouch generated screenshots. Each page identifies synthetic
fixtures and records the source version, commit and content digest. No provider
credentials or live model requests are required. Simulation screenshots remain
labelled as simulation.

## Add an element or state

1. Implement the real `.vue` component. The scanner discovers it automatically,
   along with its imports, `defineProps` and `defineEmits` contracts.
2. Add a CSF story under `storybook/`. Import and render the product component,
   then provide deterministic props or an isolated store fixture. Use the
   existing fixture modules as examples.
3. Give the story `parameters.storymap` with `app`, a useful `summary`, and
   `covers` containing project-relative Vue source paths. Add `journey` and
   `step` for workflow ordering, `route` for memory-router context, and a
   `ready` CSS selector when an asynchronous state needs a stronger assertion.
4. Exercise real controls in a `play` function and assert the resulting state.
   The capture waits for Storybook's post-play lifecycle before taking evidence.
5. Run `npm run typecheck`, `npm run storybook:ci` and the relevant behavioral
   tests. Inspect the resulting screenshots, including narrow screens.

Every source component must mount in at least one captured story. The preview
adds source IDs only in the Storybook build and records actual Vue mounts;
importing a component is insufficient. A mount establishes component coverage,
not exhaustive state or pixel coverage. Add explicit stories for materially
different states such as locked, empty, loading, failed, pending approval and
completed. A source change changes the digest; a new component without a story
fails the coverage gate.

Story data stays in memory. The preview rejects remote fetches and API calls
without a matching fixture. Factory and Orchestrator fixtures use existing
injected transport seams. Worker fixtures reset the existing reactive store and
provide explicit offline responses. Browser capture also denies external
network requests. These stories document UI behavior; the existing Worker
browser smoke test separately exercises real local transport and persistence.

## Release qualification

```sh
npm run release:build
```

This builds runtime applications, generates and qualifies the Storybook, then
packages both deliverables. Commit the intended source revision before final
qualification. `npm run release:storybook` refuses a stale commit, source digest,
failed coverage report, missing image or altered generated file. A source edit
requires regeneration; a commit requires a new qualification tied to that HEAD.

Pull requests and releases run the same Storybook gate in a dedicated Linux CI
job with the pinned Playwright browser. Release publication waits for that job
and publishes `werk-storybook-<version>.zip` with `STORYBOOK-SHA256SUMS` alongside
the existing lean runtime archives. The documentation checksum is separate from
runtime `SHA256SUMS`, preserving the runtime installer contract.

Inside the artifact, `storymap/source.json` is the scanned source contract,
`manifest.json` maps stories to screenshots and observed components, and
`qualification.json` records coverage and hashes of every generated file.
The interactive index is at the archive root; the screenshot reference is
`storymap/index.html`. See [release contents](../reference/releases.md).

## Host release documentation on GitHub Pages

The release workflow publishes the qualified Storybook to
[the project site](https://luis85.github.io/production-line/) and the illustrated
[storymap](https://luis85.github.io/production-line/storymap/). These URLs become
available after Pages is enabled and the first release with this workflow finishes.
The hosted site is replaced on every successful release, including prereleases.
Version-specific documentation remains attached to each release as a ZIP.

A repository administrator must complete this one-time setup:

1. Open **Settings → Pages → Build and deployment** and choose **GitHub Actions**
   as the source.
2. In **Settings → Environments → github-pages**, allow deployment from tags
   matching `v*`. Keep the release workflow's tag/version and `main` ancestry
   checks; a default environment rule allowing only `main` would block tag runs.
3. Merge the workflow change, then publish the next version using the
   [release procedure](../reference/releases.md#publish-a-release).

The Storybook job uploads the same static directory that passed screenshot and
archive qualification. The Pages job waits for successful release publication,
checks that this is still the most recently published release, then uses GitHub's
automatic token with `contents: read`, `pages: write` and `id-token: write` to
deploy it. Pull requests and manual branch runs cannot update the site. Deployment
stays in the release workflow because releases created by `GITHUB_TOKEN` do not
trigger another workflow through the `release` event.

The **github-pages** environment links to the deployed URL. If only Pages fails,
correct its settings and use **Re-run failed jobs** on that release run while
its seven-day Pages artifact is retained. This retries deployment without
rebuilding the site or modifying the published release. A retry for an older
release is skipped if a newer stable release or prerelease has been published;
retry the newer release's Pages job instead. After artifact expiry, ship a new
release. Do not rerun all release jobs to repair Pages: publication
intentionally refuses to replace already-published assets.
