# Code quality and architecture checks

Werk uses pinned Oxlint 1.88.0 and Fallow 3.33.1 alongside TypeScript and its
existing architecture tests. They run in normal development and CI. The tools
inspect maintained source; downloaded runtime archives do not need them.
Mutation testing is a separate, advisory release experiment described in
[mutation testing](../how-to/mutation-testing.md).

## Contributor commands

Use Node 24 and Python 3, then install the committed dependency lockfile from
`projects/werk`. Python is used only to tokenize maintained Python files in the
contributor size check; downloaded worker runtimes still need only Node.

```sh
npm ci --ignore-scripts
npm run check:fast
```

Both tools use packaged platform binaries, including Linux, macOS and Windows.
Their installed launchers work with lifecycle scripts disabled; they do not
require a first-run network download. Fallow telemetry and update checks are
disabled by Werk's wrapper. Fast checks do not require application distributions
to have been built.

| Command | What it checks |
| --- | --- |
| `npm run check:loc` | Source files at most 400 code-bearing lines; tests and helpers at most 450 |
| `npm run typecheck:tests` | Maintained JavaScript/TypeScript tests and helpers against actual source contracts, without a build |
| `npm run lint:oxlint` | Correctness rules in source, scripts, Vue scripts, Storybook and tests |
| `npm run analyze:fallow` | New or stale dead-code findings, dependency problems and service boundaries |
| `npm run analyze:fallow -- --report` | Complete current findings, including retained reviewed debt |
| `npm run analyze:fallow -- --architecture` | Fallow service-boundary checks without the dead-code baseline |
| `npm run check:architecture` | AST checks for dependency direction and pure application/domain layers |
| `npm run check:fast` | The normal static qualification gate |
| `npm run check` | Static qualification followed by builds and behavioral tests |

The complete Fallow report intentionally exits unsuccessfully while it contains
findings. It is an inspection command, not an instruction to accept everything
it reports. Use the regular command to distinguish a new regression from the
recorded baseline.

## Oxlint's role

The checked-in configuration enables correctness rules, including Vue script
checks, and fails on warnings. It detects unused imports and locals while
allowing unused callback arguments, caught errors and deliberate rest-property
omission used by privacy projections. Short-circuit and conditional expressions
with side effects remain supported.

Control-character rejection expressions intentionally use control characters in
regular expressions, so `no-control-regex` is disabled. Escape/spread style-only
suggestions are outside this initial ruleset. Two narrow, documented
`unicorn/no-invalid-fetch-options` exceptions cover request helpers whose HTTP
method is supplied dynamically. There is no whole-source warning baseline.

Blank and comment-only lines, including multiline comments, do not count toward
the size limits; lines mixing comments and code do count. The size check covers
JavaScript, TypeScript, Vue, CSS, HTML and Python and fails on unparseable files.
Split cohesive responsibilities instead of compressing code or excluding files.

The test typecheck includes maintained JavaScript and TypeScript test/support
files and mutation suites against their actual source contracts. Python fixtures
are covered by the token-based size check, not TypeScript. The checker rejects
`@ts-nocheck` and `@ts-ignore` comment directives. A documented negative fixture
may use `@ts-expect-error`; an unused expectation still fails.

Oxlint does not replace TypeScript, Vue template checking or browser tests.
Architecture fixtures run the real installed linter against deliberately invalid
code so a passing command cannot silently become an empty ruleset.

## Fallow's source graph

The configuration declares actual CLI, shipped runtime, worker-authoring,
webview, browser-test and Node-test entrypoints. Fallow's framework plugins also
recognize package scripts, Storybook and build configuration. Generated bundles,
release archives, caches and two generated HTML reports are excluded. Maintained
source files are not all treated as entrypoints: that would hide unused code.

Factory, orchestrator and worker may depend on themselves and shared modules.
Shared modules may depend only on shared modules. These Fallow boundaries run
without a baseline. The additional AST guard checks application/domain layering,
including root-level orchestrator application policy and deterministic intake
modules. General Fallow rule packs are not configured; their separate policy
engine is explicitly disabled rather than presented as measured coverage.

Tests import the applications' compiled distributions. Those paths do not exist
in a fresh checkout, so three narrow generated-import patterns have an independent
source check before Fallow runs. Each relative import must map to an existing
source file in the owning service or shared code. The check also verifies mutation
targets against the declared mutation scope and generated application manifests
against root release metadata. It rejects traversal, foreign service targets,
missing sources and files the build does not emit. Static imports, literal dynamic
imports, require calls, import types and literal URL references are inspected in
JavaScript, TypeScript, JSX, TSX and Vue scripts. Computed import expressions are
not resolved by this static check.

This makes unresolved ordinary source imports failures without requiring a build.
It does not make Fallow infer every TypeScript export's use through compiled-test
paths or an injected interface. Those limitations are visible in the reviewed
baseline rather than hidden by broad source exclusions.

## Broader architectural inspection

For the complete health and duplication report after implementation, run
`npm exec -- fallow --format json`. This includes function complexity, clone
families and historical hotspots in addition to the enforced dependency checks.
Review the findings before choosing a refactor; a dispatch function and a public
compatibility API have different constraints. This exploratory report is not the
normal gate, and its static coverage estimate is not measured test coverage.
The [architecture review](../reports/architecture-review-0.11.md) records the
cleanup and remaining follow-up areas from this increment.

## Reviewing retained findings

The native baseline in `quality/fallow-baseline.json` records exact finding
identities. `quality/fallow-baseline-review.json` records the pinned tool version,
canonical configuration and baseline hashes, category counts and a rationale for
every retained identity. Read those counts for the current reviewed snapshot.

Retained findings include compatibility-facing exports, use through compiled
integration tests or typed adapters, and cleanup candidates that require an API
review. They are not all false positives. Duplicate names in separate service APIs
are reviewed individually. A test-helper cycle represents a child-process launcher
and its watchdog, rather than a same-process recursive import. Vue and Nuxt UI are
build dependencies embedded in generated browser assets; the shipped worker does
not install them dynamically.

The wrapper forbids baselining unused files, missing or unlisted dependencies,
unresolved imports and architecture violations. It fails on new findings, stale
entries, changed provenance, malformed tool reports and degraded source analysis.
A stale entry must be removed when its cause disappears so it cannot later hide a
reintroduced problem.

To change the baseline, inspect `npm run analyze:fallow -- --report` first. Fix
real problems, check externally consumed APIs before removing exports, and review
each remaining identity. Fallow's `dead-code --save-baseline` can create a candidate
in a temporary file; it is not part of normal checks and does not update the
review metadata. Compare the candidate with the committed baseline, update each
changed rationale and both SHA-256 digests of `JSON.stringify` of the parsed JSON,
then rerun `npm run analyze:fallow`. Changes to tool version or configuration
require a fresh review. Never regenerate the baseline automatically in CI.

For the wider workflow see [development](../how-to/development.md),
[architecture](../explanation/architecture.md),
[Fallow documentation](https://fallow.tools/docs/) and
[Oxlint configuration](https://oxc.rs/docs/guide/usage/linter/config).
