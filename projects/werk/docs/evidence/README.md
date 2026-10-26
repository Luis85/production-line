# Documentation images and verification evidence

Use [current README screenshots](readme/README.md) for the maintained worker UI.
Their [provenance](readme/provenance.json) records the capture commit, version,
source digest, story, viewport and image hash. Screenshots use labelled sample
data; they do not prove live provider execution.

[Archive](archive/README.md) retains historical review captures, validation receipts
and raw mutation measurements. These records describe their original source and
must not be used as pictures of the latest release. Current operating instructions
start at [the documentation hub](../index.md).

Full component, desktop/mobile and runtime qualification is attached to the exact
release's GitHub Actions runs and Storybook archive. Keep a small curated image
set here rather than copying the entire generated catalogue into Git.

Refresh source pictures through the guarded procedure in
[README generation](../how-to/generate-readme.md). Retain historical receipts as
recorded; remove superseded unreferenced images only after checking links and
recording their hashes and recovery commit.
