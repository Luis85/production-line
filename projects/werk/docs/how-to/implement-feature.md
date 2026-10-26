# Implement a feature with the worker

Use this workflow when an attached model should change project code, run your checks and leave a reviewable result. The worker edits a separate Git worktree. Your checkout and the team's merge decision remain yours.

## Prepare the project and worker

1. Commit the project's starting state. In **Projects**, register its remote clone, preview/approve workflow publication and separately approve the committed delivery policy.
2. Configure an attached provider under **Settings → Provider connections**. For a CLI provider, sign in using the stock CLI on the worker machine. Provider availability and sign-in do not grant repository tools.
3. Pause new starts and drain queued/running work. In **Settings → Tools & MCP**, enable task-worktree file access.
4. Add a fixed command preset for each check the feature must pass. Use an absolute executable path and a JSON array of fixed arguments. Enable the preset and mark **Required feature check**, then save.
5. Review **Settings → Execution time limits**. The total task limit defaults to six hours. Tool execution defaults to 128 calls and five minutes per command. Set limits appropriate for the project's check suite. Optional command/CLI timeouts in **Tools & MCP** can shorten the global command ceiling; MCP connections have their own deadlines. Resume new starts after saving.

For Cursor CLI, also review the native Cursor permissions and hooks that apply
to the worker account and candidate workspace. Werk's file/tool grants do not
confine Cursor's native tools. Cursor implements in the retained candidate; after
it returns, the worker inspects the changes and runs the frozen required checks.
Model claims or native command output do not replace those worker-recorded
results. Cursor native subagents follow Cursor policy; the worker delegation grant
does not apply, and their usage is unavailable. See the
[Cursor execution contract](../reference/model-interaction.md#cursor-native-execution).

For a Node project with committed tests, a preset might use the worker machine's absolute Node executable and arguments `["--test", "test/slug.test.mjs"]`. A project script can run the build, tests and lint checks as one command, returning nonzero when any required step fails. On Windows use the actual executable/interpreter, not a `.cmd` shell wrapper. A clean task worktree has no `node_modules`, so install dependencies inside the worktree as part of the required check (for example run `npm ci` at the start of the check script). Do not link your checkout's dependencies into the worktree: removing a worktree refuses folders that contain symbolic links or junctions.

Existing grants operate on the candidate. A tool that resets the worktree (`git checkout`, `git clean`, `git stash`) discards the model's edits, and a tool that writes other files adds unapproved changes that fail verification. Review every command preset, project CLI grant and MCP tool before you mark a check as required.

Mark only meaningful verification commands as required. A help command that exits successfully does not establish feature correctness. General command presets, project CLI grants and MCP tools can still assist the model, but only the frozen required checks establish candidate verification.

## Submit one feature request

For a worker bound to shared Git intake, create a draft from the committed project
template in your editor or through **Workboard → New Feature Request → Prepare request**.
Complete its approved paths and acceptance criteria, check readiness, then mark
it ready and commit/push it. In the webview, **Mark ready and publish** performs
that publication. The shared watcher claims the same Feature Request; the chat
interface does not bypass Git or create a second implementation workflow.

New Home work uses this project Git-authoring flow. Include intended new files
and deletions in the approved scope; a request cannot widen its own authority.
Retained legacy approved-file tasks keep their saved execution contract.

For a team batch, follow the [evening handoff and morning review](shared-feature-intake.md#work-during-the-day-implement-overnight).

For example:

> Implement slug normalization in `src/slug.mjs`. Collapse runs of spaces and underscores into one hyphen, trim leading/trailing separators and preserve existing Unicode behavior. Update `docs/slugs.md`. Run the configured slug acceptance check, fix failures and finish with a summary of the implemented behavior and remaining limitations.

The composer explains the available execution mode. A newly accepted Git-backed request uses implementation tools when file access and at least one enabled required check are saved. Otherwise it produces a proposal only. Existing saved tasks retain their original mode; changing settings does not silently upgrade their authority.

Every interaction has a Markdown feature-request record. Instructions, follow-ups, questions, execution attempts and results remain attached to that same task.

## Follow implementation and verification

The model can inspect the worktree, apply approved changes, run a required check, read its output and repair the candidate. The worker records the candidate digest and each required command's outcome. Edits invalidate earlier verification; all required checks must pass against the final candidate before it becomes verified review work.

Inspect the selected task's implementation evidence and Markdown record. A failed or missing check remains visible. A completed model response alone cannot establish that the feature works. Check the recorded candidate and verification results rather than relying on a claim in the model's summary.

If the model needs another path or a changed check plan, inspect the retained work and create a new request with the revised approval. Changing or revoking file/check grants blocks the saved implementation plan. Cancelled or interrupted attempts retain their worktree; resume explicitly after addressing the blocker. Never delete an unfamiliar retained worktree to clear an error.

## Review the result

Open the saved patch and verify the requested behavior, changed paths and check results. The patch is generated from the actual candidate worktree. Generic verification commands record observed exit status; they do not prove untested behavior, security properties or usability.

Local requests retain a review patch in the worker. When using [shared Git intake](shared-feature-intake.md), the worker also publishes the feature branch and an Obsidian-compatible review note after the configured completion rules pass. Inspect the branch and review note through the team's normal process before merging.

To require candidate verification for shared requests, add a rule to the `patch` rules in the configured `fr-done-check.json`:

```json
{"id":"candidate-verified","fact":"output.verificationPassed","op":"eq","value":true}
```

This supplements the existing mandatory rules. Proposal-only or unverified results cannot satisfy it. The check configuration is pinned when the request is accepted; changing the file later does not rewrite an active request's evidence.

## Current limits

A request approves at most 32 entries. An entry is an exact text-file path or, for an
implementation request, a folder ending in `/`, such as
`src/frontend/src/app/features/auftrag/`. A folder entry lets the worker create,
change and delete files below it, for example the output of a project code
generator. Files below the folder with dot-prefixed, secret-like or otherwise unsafe
names stay unapproved, and the repository root cannot be approved. A proposal
request (no implementation tools or required checks) keeps exact files only and
refuses folder entries.

Initial input is limited to 24,000 bytes per exact file and 48,000 characters total;
a folder entry snapshots no contents, because the model reads files with its tools.
The edited candidate is bounded by three execution settings:

| Setting | Default | Bounds |
| --- | --- | --- |
| `candidateApprovedFileMaxBytes` | 24,000 bytes | One exact approved file, or one changed file below an approved folder |
| `candidateApprovedTotalMaxBytes` | 48,000 bytes | All exact approved files plus changed files below approved folders |
| `candidateReviewPatchMaxBytes` | 120,000 bytes, at most 4 MiB | The review patch |

Unchanged files below an approved folder are inspected like other source files and
do not count toward the approved limits. Every changed approved file appears in the
review patch, so the patch limit (at most 4 MiB) also bounds approved content in
practice, whatever the per-file and total settings allow.
`werk_candidate_status` and `werk_candidate_apply` return a listing bounded to 64 KiB:
exact approved files and requested paths with hashes, then changed files (marked
`changed`; beyond the budget without hashes, then only counted) and up to 200 other
files below approved folders. `filesNote` says when the listing is incomplete; the
model requests the hashes of other files by path. A file below an approved folder that
the repository's `.gitignore` excludes is refused, because it would be neither
reviewed nor published. Approved files must be UTF-8 text. The
review patch contains only approved paths. An error names the measured size, the
limit and the setting, for example `Approved candidate text is 60,000 bytes; the
approved content limit is 48,000 bytes (execution.candidateApprovedTotalMaxBytes).`
Raise the named setting with `settings set` (see
[worker execution policy](../reference/configuration.md#local-worker-execution-policy));
a new attempt captures it.

The taskboard stores each review patch in a document limited to 16 MiB in total,
which is why a review patch is limited to 4 MiB. Split larger changes into
reviewable features.

Shared feature publication keeps its own fixed bounds: a patch of at most 131,072
UTF-8 bytes (128 KiB) and at most 32 changed files, counted as the patch's Git file
headers. The approved content settings above do not raise them. Two layers enforce
the same measurement, so they cannot disagree:

1. **During implementation.** An implementation request admitted through
   [shared intake](../reference/shared-feature-intake.md#request-and-template-contract)
   freezes these bounds with its scope. `werk_candidate_status` and
   `werk_candidate_apply` return `sharedPublication` with both bounds and the
   candidate's `patchBytes` and `changedFileCount`, plus an `error` once either
   bound is exceeded, for example `Shared publication limit: The retained candidate
   changes 33 files; shared feature publication allows at most 32 changed files.
   Reduce the change before verification; required checks fail while it exceeds
   the limit.` Every required check on such a candidate fails with that message
   without running, so the request cannot reach review; reduce the change and run
   the checks again. Local requests are unaffected.
2. **After verification.** If a completed shared result still exceeds the bounds,
   for example a request admitted before scopes recorded them, the worker retains
   the candidate instead of pushing it and publishes a blocked Task note with
   recovery guidance. Ask a maintainer to inspect it or create smaller successor
   requests; editing that diagnostic note does not rerun implementation.

Candidate verification inspects every tracked file and every nonignored untracked
file, including files outside the approved edit list. Repositories containing
symlinks, hard-linked source files, submodules, sparse or assume-unchanged index
entries are currently refused. By default, files outside the approved edit list,
including binary assets, are limited to 8 MiB each; the complete source inspection
is limited to 20,000 paths and 64 MiB. The path count includes approved new paths.
Untracked ignored dependency/build outputs are excluded.

If inspection reports a size or file-count limit, open **Settings → Execution time limits**
and expand **Repository inspection limits**. Raise the named bound to cover the
project, keeping the individual-file limit within the total, then **Save execution limits**. The CLI exposes the same values through
`settings set`; see [worker execution policy](../reference/configuration.md#local-worker-execution-policy).
A successful inspection still reads and fingerprints every included file. These
settings do not widen the approved edit list or the approved content limits.
A new attempt captures current settings; a queued or running attempt keeps its
prepared values. Inspect the request's retained result and use its available
retry/resume action after resolving the blocker.

A dependency installer or external MCP tool has the authority of its saved grant;
a Git worktree is not an operating-system sandbox.

See [model tool permissions](manage-model-tools.md), [question and recovery controls](answer-and-resume-worker.md), and the [worker–model contract](../reference/model-interaction.md) for detailed behavior.
