# Forge continuation tool report

Observed on 2026-10-12 with the published Forge 0.1.0 and Node 24.19.0 while improving Werk. This report records the independent CLI audit before dispatching upstream implementation agents. Product implementation and integrated verification are recorded separately in the continuation review.

## Tool usage

Forge project/current, read, list, search, help/schema, revision-guarded apply previews, backlog and workflow commands support the product work. All authored source, tests and project documents use the guarded write workflow. Forge browser tools are used for captures where supported. Shell/Node/npm and direct Playwright remain necessary for executable tests, process orchestration and browser assertions. Collaboration agents are dispatched by the host; Forge agents manages agent definitions, not running agents.

## Selected upstream improvements

### Search exclusions

`search MockAdapter --path 'src/**' --limit 4` returns four generated dist hits on its first page. The total of eight includes duplicated source/build content. `--exclude '**/dist/**'` fails with UNKNOWN_OPTION. This is missing functionality, not a violation of the documented search behavior.

Add an explicit exclusion glob, using existing brace syntax for alternatives. Filter excluded files before reading contents; bind pagination cursors to the exclusion as part of the query identity. Preserve default search behavior and do not silently adopt Git ignore rules. Cover include/exclude intersection, excluded unreadable files, invalid patterns, pagination and portable CLI behavior. Update help, schema, localized strings and documentation.

### Browser status diagnostics

Default `browser status` reports unavailable managed Chromium. Passing `--browser-executable /usr/bin/chromium` works today. Passing `/bin/true` also reports available: the current check verifies an executable file, not browser compatibility. No new launch or system discovery is needed.

Add an explicit verification level, structured reason and actionable next step for missing/non-file/non-executable paths. Clarify that the reported runtime version identifies Playwright. Keep status side-effect-free and selection priority explicit option, environment override, managed browser. Test that it never launches arbitrary executables or performs network work.

## Tools still needed

- A bounded read-many operation with per-file revisions would reduce repeated process startup and JSON envelopes. Define partial failures before implementing it.
- Invocation-local project selection or an expected-project guard would help parallel agents. Today selection is held fixed in each workspace.
- A configured project-check runner could capture command exit status, bounded output and source revisions. Today npm checks and evidence collection require external orchestration; UTF-8 validation alone does not typecheck TypeScript.
- Browser assertions, console collection and mocked responses still need direct Playwright. Screenshot capture errors could expose safe stage/reason codes without leaking URLs or credentials.
- Command/action schema projections would reduce output; command-specific schema already exists.

A wrong use of backlog --view with a base file path produced BACKLOG_NOT_FOUND; consulting help and using --base corrected it. This was an invocation mistake, not a CLI defect.

## Upstream delivery status

The earlier tutorial/container-text changes remain in [PR 23](https://github.com/Luis85/agent-cli/pull/23). [PR 24](https://github.com/Luis85/agent-cli/pull/24) branches directly from main and contains only this pass's selected changes. The Werk installation remains the published release; the proposed CLI changes have not been installed over it.

## Implementation and verification

Two dedicated Forge agents implemented both selected changes in an independent worktree. Source review found no blocking issue. The rebuilt CLI reproduces the original Werk search case with exactly four source hits and no generated dist hits when exclusion is supplied. Browser status now reports verification: executable-only, a stable reason and recovery guidance; checking /bin/true correctly remains a file-availability check and does not imply Chromium compatibility.

English/German action help is updated. New nextStep diagnostic prose is currently English; stable reason codes are language-independent. Upstream checks and the PR are recorded below.

Additional friction from implementation: the packaged browser test suite and source pipeline require separate npm/build steps; generated distributions must be rebuilt before portable CLI tests. Source agents therefore used isolated checks, and the parent runs the coherent upstream gate. No new dependency or implicit executable launch was introduced.

## Delivered upstream pull request

[Forge PR 24 — Add search exclusions and explicit browser status diagnostics](https://github.com/Luis85/agent-cli/pull/24) is open, non-draft and unmerged. Base: main. Branch: codex/forge-search-browser-diagnostics. Exact commit: 7d63e3388962d9858060ea34c2115fe814e89dac. The worktree is clean after pushing 28 changed files. No merge, reviewer request or extra comment was made.

Validation: structure, lint, analysis, TypeScript, portable build and **2,746 tests passed, 2 skipped**. The initial full check stopped at its final showcase stage because four generated skill documents were stale. Regeneration changed only those four copies; a subsequent `npm run showcase:check` passed with no differences across 276 files. Application source was unchanged after its tests. This records the resolved gate failure rather than claiming the first command exited successfully.

Both selected changes have dedicated implementation agents and independent review. Rebuilt CLI reproductions passed against Werk and explicit browser paths. The immediate GitHub workflow query listed no runs yet, so remote CI is not represented as passed. Prior PR 23 remains separate.

The showcase failure was useful drift detection, not a CLI defect. A more discoverable checklist connecting authored skills, packaged skills and showcase copies would reduce this release-workflow friction.
