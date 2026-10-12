# Forge tool usage and improvement report

Latest work: [Continuation review](continuation-review.md) records 226 passing tests, the context command, pagination, retention and recovery improvements.

Observed with The Forge v0.1.0 while importing and hardening Werk on 2026-10-12. The CLI handled project/vault management and guarded mutations; orchestration subagents performed review, and Node/npm/Docker/Playwright performed executable checks.

## Tools used and why

| CLI tools | Purpose |
| --- | --- |
| version, help, schema, config, plugins, skills | Inspect installed capabilities, exact input contracts and scope |
| project list/current/inspect/open | Establish the managed project; selection was held fixed throughout parallel work |
| read, apply --dry-run, apply, create --stdin, edit, validate | Revision-guarded source, test, documentation and binary-evidence writes; inspect diffs before applying |
| search, list, links, vault | Source/document discovery and strict link/structure validation |
| backlog add/set/show/list/board/check and dependency commands | Import planned work; track six hardening workstreams independently of unfinished product features |
| bases, templates, agents and related validation | Inspect planning/tooling contracts and whether configured resources existed |
| workflows list/sync --dry-run/sync/sync --check | Generate CI from project-owned workflow source and detect drift |
| browser status/screenshot/validate | Capture visual evidence and reproduce Markdown tutorial extraction behavior |
| server start/status | Run and inspect the local read-only admin |
| connectors, Claude/component/data-source capability inspection | Establish available boundaries; no external sync, installations or unrelated mutations were performed |

The independent audit exercised 28 read-only capability operations plus targeted negative probes. Applicable write tools were used for the work; every catalog mutation was not executed merely for coverage. Shell tools were required for scratch plan composition, package installation, type checking, tests, Docker builds and browser assertions. Forge's agents command manages definitions; it does not dispatch these orchestration subagents.

## Verified findings and priorities

### P1 — Markdown tutorial extraction interprets literal examples as executable plans

`src/plugins/browser/domain/tutorial.ts` extracts fences with a regular expression. A `forge-tutorial` block shown inside an outer four-backtick Markdown example is incorrectly accepted by `browser validate`; a valid fence with a longer closing delimiter is rejected with `BROWSER_FLOW_INVALID`. These were reproduced against the installed CLI without launching a browser.

Expected behavior: extract real fenced code nodes, ignore literal/indented examples, support valid CommonMark closing fences and preserve exactly-one-plan validation for Markdown and Canvas text. Regression fixtures and tests are the first selected upstream change.

### P2 — Dockerfile/Containerfile should be editable text

Extensionless Dockerfile is currently a documented opaque attachment: read returns base64, literal editing is unavailable and dry-run has no text diff. During this pass an agent accidentally wrote the base64 representation into Dockerfile. Inspection caught it before the container build; the file was restored with a guarded write and all image builds then passed. This was a handling mistake made easier by the current format contract, not silent CLI corruption.

Selected improvement: explicitly classify Dockerfile and Containerfile as text, preserving lossless UTF-8/BOM/CRLF behavior and the codec's existing binary fallback. Keep unrelated unknown filenames and dotfiles unchanged. Update format discovery/docs and test read/edit/diff/search behavior.

### P2 — Parallel file operations depend on global selected project

`read README.md --project werk --json` fails with `UNKNOWN_OPTION`. We coordinated selection and guarded revisions, but checking selection does not reserve it for the next command. A future invocation-local project selector or expected-project guard would reduce misrouting risk. This broader routing change is deferred from the focused PR.

### P2 — Structured execution evidence requires external orchestration

TypeScript validate checks UTF-8, not type correctness. There is no native project check runner collecting bounded command exit status, source revision and test artifacts. Consider an explicit allowlisted project-check adapter; do not add unrestricted shell execution implicitly.

### P3 — Discovery and diagnostics improvements

- Source search includes dist output despite .gitignore; use source-specific globs today. Consider explicit exclude filters or opt-in Git ignores.
- Large schema envelopes are difficult to inspect. Compact command/action projections and read-many revision bundles would reduce orchestration overhead.
- Browser status checks managed Chromium and can say unavailable when system Chromium works via --browser-executable. Add a clearer hint or explicit discovery mode. Clarify that the current version value is the Playwright runtime version.
- --from resolves within the project; stdin is the correct bridge for external scratch files. Make this distinction prominent in help.
- Empty agent/workflow validation is valid but does not prove configured coverage. Optional require-nonempty checks would help CI.
- Browser screenshots lack assertions, console collection and mocked responses; direct packaged Playwright was needed for those checks.

`project current` reports workspace command context and the saved selection in data.project by design; this is documented behavior, not a defect. Scoped paths, external-file refusal and revision conflicts are useful protections, not issues to bypass.

## Upstream follow-up

Two implementation subagents delivered both selected changes, followed by independent review. [Forge PR #23](https://github.com/Luis85/agent-cli/pull/23) is open against main from codex/forge-tutorial-container-text, commit 71caa2242081f11ec84680eb4187d1b1894b5e26.

The Forge full check passed: structure, lint, analysis, TypeScript, portable build, **2,771 tests passed and 2 skipped**, plus a clean showcase drift check across 276 files. Original CLI reproduction fixtures were rechecked against the rebuilt distribution. The source, tests, documentation and regenerated bundle are included. Remote GitHub CI was queued/running when the PR was verified; it has not been represented as passed or merged.

The Werk workspace retains the published v0.1.0 CLI. The proposed improvements are in the PR; no broader routing or external-provider work is included.
