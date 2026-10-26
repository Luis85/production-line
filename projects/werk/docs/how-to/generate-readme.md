# Generate the READMEs and their screenshots

The repository landing README and project README are generated from the maintained [project overview](https://github.com/Luis85/production-line/blob/main/projects/werk/docs/overview.md).
That page preserves the worker → Orchestrator → Factory journey and also appears
in the public handbook. Keep operating procedures in their existing linked guides;
change the overview when the introduction or journey needs to change. Do not
maintain another independent copy of the README prose.

## Update the text

From the source project with Node 24 and dependencies installed:

```sh
npm run readme:generate
npm run readme:check
```

Edit `docs/overview.md`, then generate and review both READMEs in the same change.
In this Forge checkout, the repository landing page uses the same complete journey
with `projects/werk/` links; there is no second prose source. The generator detects
the exact Git-root `projects/werk` layout and Forge configuration before including
the parent output. Standalone project copies and test fixtures only generate their
own README.
The generator rebases relative Markdown links and preserves code examples. Image
slots in the overview use `<!-- readme-image: worker-taskboard -->`; their story
ID, viewport, filename, accessible description and caption live in
`storybook/readme.json`. Every selection must have exactly one slot. The normal
`check:fast` gate rejects drift in either generated README. A generation command
performs no provider calls, Git commits or publication.

## Select real UI screenshots

Choose stable IDs from the actual Storybook stories, with deterministic fixtures
and a visible sample-data label. The manifest selects Workboard, project selection, focused request authoring,
Review, Workflow, Worker health and the Settings directory. The release uses
the exact desktop/mobile PNG bytes produced by the existing full-page capture;
it does not redraw, crop, retouch or synthesize the interface.

First regenerate the README text and commit the intended source. Then qualify:

```sh
npm run storybook:ci
npm run release:readme
```

This creates `release/werk-readme-<version>.zip` and `release/README-SHA256SUMS`.
The ZIP contains `README.md`, selected images and
`docs/evidence/readme/provenance.json`. Provenance records the version, Git commit,
source digest, capture/fixture timestamps, story IDs, viewports, dimensions and
image hashes. The companion Markdown explains that these are sample data and
not evidence of live model execution. Links to other project files are pinned
to the source commit; images remain local to the artifact.

Generation and scratch export require a clean source checkout, including tracked
and untracked project files; ignored build outputs are allowed. This ensures that
commit-pinned links identify the content that was captured. They reject failed or
incomplete Storybook qualification, stale HEAD or source digest, changed image
bytes, missing/ambiguous stories and invalid capture metadata. It never modifies `storybook-static`, the source README or tracked
pictures. Use a new capture after any source edit or commit.

## Refresh the repository's pictures

Release generation always includes fresh qualified images. Updating the pictures
shown on GitHub is an explicit reviewed source change before tagging:

```sh
node scripts/release/readme-package.mjs --export release/readme-refresh
```

Use a new scratch directory under ignored `release/`, or outside the project;
existing exports are refused. A scratch folder under unignored `work/` would
prevent the clean-source check until removed or excluded locally. Inspect its screenshots
and provenance. Adopt only `docs/evidence/readme/` from the export into the same
source directory using the repository's guarded editing workflow, review the
image diff, and commit. Do not copy the exported `README.md` over the project
README: artifact links are commit-pinned, while source links are relative.
Run `npm run readme:generate` for the source README instead.

Finally rebuild and qualify Storybook for that new commit. This final capture is
used for release packaging; it does not trigger another source-image refresh.
Tracked pictures retain their honest capture commit and are not relabelled as a
new capture. The generated repository landing page reuses these same tracked
pictures.

## Keep current images separate from history

[Documentation evidence](../evidence/README.md) separates the current curated
`readme/` pictures from `archive/`. Never replace historical screenshots with a
new UI: they substantiate dated reports. Keep raw validation and mutation receipts.
Before removing an unreferenced image, check maintained links and receipt references,
record its hash and recovery commit, then run the strict documentation check.

## Why generation does not loop

The maintained overview, screenshot manifest, generation code and generated project
README text enter the Storybook source digest. The repository landing is checked
against that same source before packaging; it introduces no new source input.
Text generation happens **before** capture.
Selected pictures/provenance are output evidence under `docs/evidence/readme`,
which is outside that source inventory. The release ZIP is an ignored output.
No output checksum is written back into the maintained source or the qualified
site. Storybook packaging and README packaging share one qualification reader.

The release workflow generates the README candidate only after the Storybook
browser gate passes, retains it as an Actions artifact and publishes it with the
other assets after runtime qualification succeeds. It never silently commits to
`main`, rewrites a tag, or publishes an unqualified candidate. The installed
runtime keeps its separate concise startup README.
