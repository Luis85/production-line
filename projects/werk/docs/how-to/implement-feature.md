# Implement a feature with the worker

Use this workflow when an attached model should change project code, run your checks and leave a reviewable result. The worker edits a separate Git worktree. Your checkout and the team's merge decision remain yours.

## Prepare the project and worker

1. Commit the project's starting state. In **Settings → Repositories**, assign the repository to the worker and accept its use if it was discovered locally.
2. Configure an attached provider under **Settings → Providers & accounts**. For a CLI provider, sign in using the stock CLI on the worker machine. Provider availability and sign-in do not grant repository tools.
3. Pause new starts and drain queued/running work. In **Settings → Tools & MCP**, enable task-worktree file access.
4. Add a fixed command preset for each check the feature must pass. Use an absolute executable path and a JSON array of fixed arguments. Enable the preset and mark **Required feature check**, then save.
5. Review **Settings → Queue & duration**. The total task limit defaults to six hours. Tool execution defaults to 128 calls and five minutes per command. Set limits appropriate for the project's check suite. Optional command/CLI timeouts in **Tools & MCP** can shorten the global command ceiling; MCP connections have their own deadlines. Resume new starts after saving.

For a Node project with committed tests, a preset might use the worker machine's absolute Node executable and arguments `["--test", "test/slug.test.mjs"]`. A project script can run the build, tests and lint checks as one command, returning nonzero when any required step fails. On Windows use the actual executable/interpreter, not a `.cmd` shell wrapper. A clean task worktree has no `node_modules`, so install dependencies inside the worktree as part of the required check (for example run `npm ci` at the start of the check script). Do not link your checkout's dependencies into the worktree: removing a worktree refuses folders that contain symbolic links or junctions.

Existing grants operate on the candidate. A tool that resets the worktree (`git checkout`, `git clean`, `git stash`) discards the model's edits, and a tool that writes other files adds unapproved changes that fail verification. Review every command preset, project CLI grant and MCP tool before you mark a check as required.

Mark only meaningful verification commands as required. A help command that exits successfully does not establish feature correctness. General command presets, project CLI grants and MCP tools can still assist the model, but only the frozen required checks establish candidate verification.

## Submit one feature request

For a worker bound to shared Git intake, create a draft from the committed project
template in your editor or through **Taskboard → New request → Prepare request**.
Complete its approved paths and acceptance criteria, check readiness, then mark
it ready and commit/push it. In the webview, **Mark ready and publish** performs
that publication. The shared watcher claims the same Feature Request; the chat
interface does not bypass Git or create a second implementation workflow.

For a standalone local worker without a shared binding, describe the behavior in
**Taskboard → New request**. Expand **Repository files · optional**, enable
**Allow changes to approved repository files**, choose the repository and list
the files the implementation may change. Both paths use the same execution and
verification contracts. Include intended new files and deletions; a request
cannot widen its own approved scope.

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

A request approves at most 32 text-file paths. Initial input is limited to 24,000 bytes per file and 48,000 characters total; the edited candidate is limited to 24,000 bytes per approved file and 48,000 bytes total, with a 120,000-byte review patch. Approved binary files, secret-like paths, dotfiles and path traversal are excluded. Split larger changes into reviewable features.

Candidate verification inspects every tracked and nonignored source file, including files outside the approved edit list. Repositories containing symlinks, hard-linked source files, submodules, sparse or assume-unchanged index entries are currently refused. Unapproved binary source files are supported up to 8 MiB each; the source snapshot is limited to 20,000 files and 64 MiB. Ignored dependency/build outputs are excluded from the snapshot. A dependency installer or external MCP tool has the authority of its saved grant; a Git worktree is not an operating-system sandbox.

See [model tool permissions](manage-model-tools.md), [question and recovery controls](answer-and-resume-worker.md), and the [worker–model contract](../reference/model-interaction.md) for detailed behavior.
