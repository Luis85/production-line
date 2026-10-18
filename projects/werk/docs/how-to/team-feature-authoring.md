# Author feature requests with your team

Use a committed authoring kit to write and validate requests in any clone of a
project. Authors need Node 24 and their usual editor or coding assistant. They do
not need a running worker, provider credentials, an installed project worker, or
an npm dependency installation.

## Install the kit once

From a downloaded Werk release, run the portable worker CLI against your project:

```sh
node /path/to/werk/bin/apps/worker/cli.mjs feature setup --project-dir /path/to/project
```

Use `--features-dir requests/features` to choose a different queue,
`--workflow-dir Vault/Workflows` to keep the Base, reviews, tasks and checks in one
folder instead of the project root (a new workflow only; an existing
`.werk/feature-workflow.json` wins and a differing folder is reported as a warning) and
`--provider claude-cli` to seed a new template for Claude (otherwise `codex-cli`).
Existing templates are preserved. Setup also
runs during [project worker initialization](project-worker.md). When a worker
configuration already exists, standalone setup adopts its feature directory.
Repeating setup preserves existing files and team customization; only an
unmodified authoring script is refreshed (see below). A configured
folder mismatch or malformed check file is reported before setup writes files.
An older template is preserved with a warning explaining the required update.

Commit these generated files with the project:

| File | Purpose |
| --- | --- |
| `.werk/feature-workflow.json` | Paths and stable identity for the shared workflow |
| `.werk/authoring/feature-request.mjs` | Self-contained authoring CLI |
| `.werk/authoring/.gitignore` | Excludes the temporary authoring write lock |
| `.werk/authoring/manifest.json` | Content hash of the authoring script that Werk installed |
| `fr-ready-check.json`, `fr-done-check.json` | Team readiness and completion rules |
| `features/_templates/feature-request.md` | Editable request template |
| `Feature Requests.base` | Obsidian views of requests, human Tasks and PullRequest review notes |
| `.agents/skills/create-feature-request/SKILL.md` | Create Feature Request skill for compatible agents |
| `.claude/skills/create-feature-request/SKILL.md` | The same skill for Claude Code |

Queue and template locations follow your selected folder. New Bases use Obsidian's
built-in table view with **Team feature requests**, **Human tasks** and **Pull
requests**. Request rows expose the worker and its `werkTask` / `werkPullRequest`
links. No special backlog plugin is needed. Open the project as an Obsidian vault
and pull shared Git updates to see current notes. Setup preserves an existing Base;
review and add the new views/columns yourself when upgrading a customized one.

### Refresh the authoring script after an upgrade

After updating the worker app, run `feature setup` again so the committed
`.werk/authoring/feature-request.mjs` matches the new worker. An outdated script
can reject fields that the new worker accepts, such as `definitionRef`.

Setup records the content hash of the script it installs in
`.werk/authoring/manifest.json`. Line endings are ignored, so a Windows checkout
with CRLF still matches. While the committed script still matches that record,
setup replaces it with the bundled script and reports both files as `updated`.
Review and commit both files so teammates receive them with their next pull.

Setup preserves the script and returns the warning `authoring_script_outdated` with
the file's current `revision` when it cannot prove the script is unmodified. This
happens when the team changed the script, or when the project was set up before
Werk 0.10.0 and has no manifest. Compare the two files:

```sh
git diff --no-index .werk/authoring/feature-request.mjs bin/apps/worker/src/worker/dist/worker/authoring/feature-request.mjs
```

If the bundled script should replace the committed one, name the revision you
inspected. Setup refuses the replacement if the file changed since then:

```sh
node bin/apps/worker/cli.mjs feature setup --if-match REVISION
```

The replacement also records the new script in the manifest, so later upgrades
refresh it automatically. Run `node .werk/authoring/feature-request.mjs validate --file`
on an existing request, then commit the script and manifest. To keep a customized
script, leave it as it is; setup never records a customized script as managed.

## Create and finish a draft

In a clone containing the committed kit, work from the repository root:

```sh
node .werk/authoring/feature-request.mjs create --name search.md --title "Find matching requests"
```

The command copies the current template, assigns a stable `fr-…` ID, and writes a
new draft. Existing requests are never overwritten. Fill in Goal, Context,
Acceptance criteria, and Verification plan. Keep the Markdown body within 8,000
characters. Shared implementation requests use `mode: patch`; replace the empty
`paths` list with the project-relative files you approve for this request.
New templates include the provider chosen at worker initialization (or `codex-cli`
for authoring-only setup). Preserve that selection unless the operator has
configured another connection; creating a request does not configure its provider.

For example, replace `paths: []` with `paths: [src/search.ts]`, describe the user
problem, add an observable checklist item, and explain how a reviewer will verify
it. Approved paths may use umlauts, `ß`, commas, parentheses, `&`, apostrophes,
dashes and arrows. Use a block list for names with such characters, because in
`[a, b]` a comma separates two paths:

```yaml
paths:
  - docs/requirements/LACF-REQ-033 Warenein- und -ausgang einschließlich Zoll abwickeln.md
  - "docs/Kunden's Änderungen (Größe).md"
```

See [approved file paths](../reference/feature-requests.md#approved-file-paths)
for the complete rule. Comment-only placeholders do not count as answers. Ask your coding assistant
to use **Create Feature Request** if you want help identifying gaps. The skill
instructs it to clarify missing decisions with you instead of inventing them.

Validate the draft:

```sh
node .werk/authoring/feature-request.mjs validate --file features/search.md
```

The JSON result includes `valid`, errors and the file's `revision`. Invalid
requests return exit code 2. Without a Ready Check, it also includes deterministic
rule results: resolve missing sections, approved paths, template requirements
and configured rule failures, then validate again.

With a [Ready Check](#review-requests-before-implementation) configured, `valid`
means structurally eligible for model review, not ready for implementation. This
stage does not evaluate the definition of ready. The returned `policy` describes
the configured rules; it does not prove they passed. Incomplete input can be
submitted for clarification while identity, bounded-input and safe-path checks
remain enforced. Validation reads the current template, check files and configured
prompts; it does not run the model, contact a worker or change the request.

## Explicitly queue the request

When you intend the worker to pick up this work, copy the revision from successful
validation into this command:

```sh
node .werk/authoring/feature-request.mjs ready --file features/search.md --if-match REVISION
```

Submission checks run again against the current file and rules before `draft`
changes to `ready`. A configured Ready Check accepts structurally valid input for
review; otherwise full readiness is required. A stale revision requires reading
and validating the changed file. Commit the ready request and use your normal
Git review and push workflow.
Creating or validating a draft does not queue it. Neither a local save nor a
local commit dispatches shared work. A connected worker can claim the ready
request only after its commit is pushed to the watched remote branch.

Once a worker owns a request, preserve its generated lifecycle metadata. If its
Ready Check is waiting for the team, follow the [same-note response procedure](#review-requests-before-implementation)
below. Otherwise leave accepted input unchanged. The authoring script rejects
readiness mutations of worker-owned or already queued files; edit the generated
Ready Check response in your editor. Use a successor draft for changed work after
implementation admission and retain the original ID with its history. Human review
is still required before merging implementation changes; a worker publication or completion check is not a merge approval.

If you also have a project worker, its CLI exposes the same implementation through
`feature author create`, `feature author validate`, and `feature author ready`.
The existing `feature create` and `feature validate` commands remain part of the
live worker API. The standalone script remains sufficient for authors.

The portable app also supplies npm aliases without an npm install:

```sh
npm --prefix bin/apps/worker run feature:author:create -- --name search.md --title "Find matching requests"
npm --prefix bin/apps/worker run feature:author:validate -- --file features/search.md
```

Use `feature:setup` and `feature:author:ready` for setup and guarded readiness.
When worker initialization creates a previously missing project `package.json`,
it adds equivalent root aliases prefixed with `worker:`, such as
`npm run worker:feature:author:validate -- --file features/search.md`. Existing
project manifests are preserved. Authoring-only setup does not add an app or a
package manifest, so the standalone Node commands remain the portable option.

## Follow progress and answer the worker

Pull the shared branch to update the original request's progress and linked notes.
If it is waiting at the optional [Ready Check](#review-requests-before-implementation),
respond in that Feature Request. After implementation admission, keep its accepted
body and worker-owned fields unchanged. A linked **Task** with `action: answer` or
`action: resume` is the supported response channel:

1. Read the question, choices or failure reason and obtain the actual human
   decision where required.
2. Edit only its `## Answer` section and set `status: ready`. Keep all generated
   identity, owner, checkpoint, action and revision fields intact.
3. Commit and push the Task. The owning worker validates it and continues the
   existing request automatically; pull again to see `processed` or an error.

An answer must be nonempty. A processed response can still be waiting for queue
capacity. Resume is offered only for supported failed/interrupted latest turns.
A **blocked** diagnostic Task describes an operator action and has no executable
Answer; editing it cannot grant tools or satisfy an attestation gate.

When the request reaches `ready_for_review`, follow `werkPullRequest` to its
**PullRequest** Markdown note and inspect the feature branch and evidence. This
is a review handoff, not an automatically created hosting-service pull request or
merge approval. See [shared intake](shared-feature-intake.md) for setup, recovery
and the distinction between execution, publication and human merge.

## Select a provider, model and effort

Set these optional fields in the template or an unclaimed draft when the team
needs a particular execution selection:

```yaml
provider: codex-cli
model: YOUR_MODEL_ID
effort: high
```

The offline authoring command also accepts `--provider ID`, `--model NAME` and
`--effort LEVEL` when creating a request. Omitted flags preserve template values.
An offline author cannot inspect the worker's defaults, so provider-specific effort
validation waits until intake when no provider is specified.

Replace `YOUR_MODEL_ID` with a model available to the selected connection. Omit
`model` to inherit a compatible instruction-profile model, otherwise the
provider's worker default. Omit `effort` to inherit the worker's default effort;
set `effort: default` for the provider's own behavior. Supported effort values
vary by provider and model; Cursor CLI accepts only `default`.

For Cursor, select `provider: cursor-cli` after the operator configures its native
CLI connection. For portable team defaults, the operator can edit **Settings →
Providers & accounts**; an omitted provider uses that worker's default. Explicit
provider values already in committed templates remain explicit.

Once claimed, provider, model and effort remain fixed through Ready Check answers,
implementation and restart recovery. Update an unclaimed draft or create a new
Feature Request to change them. See the
[selection contract](../reference/model-interaction.md#provider-model-and-effort-selection)
and [provider setup](use-worker-webview.md#connect-claude-codex-or-cursor).

## Select an instruction profile for the team

To run team requests with a [Docker Agent instruction profile](../reference/agent-definitions.md),
use a stable reference in the template or request frontmatter. Do not commit a
`definitionId`: it is generated by one worker and differs on every other worker.

```yaml
definitionRef: project-reviewer
agent: root
```

The worker operator imports the profile YAML and assigns the same reference on
each worker that processes the team's requests:

```sh
node bin/apps/worker/cli.mjs definition list
node bin/apps/worker/cli.mjs definition ref --id DEFINITION_ID --ref project-reviewer
```

Keep the profile YAML in the repository if the team reviews it, for example under
`.werk/agents/project-reviewer.yaml`. Workers do not load it from the repository;
the operator imports it after reviewing the preview. After a reviewed change, the
operator updates the profile in place on each worker, keeping the reference:

```sh
node bin/apps/worker/cli.mjs definition update --ref project-reviewer --file .werk/agents/project-reviewer.yaml --dry-run
node bin/apps/worker/cli.mjs definition update --ref project-reviewer --file .werk/agents/project-reviewer.yaml --if-match REVISION
```

A `--file` ending in `.yaml` or `.yml` is sent as the profile itself, so the
committed file needs no JSON wrapper. Add `--name NAME` to rename the profile;
without it the stored name stays. A JSON `update.json` with `{"yaml":"YAML_TEXT"}`
still works. Tasks created earlier keep the profile they accepted; later tasks
use the update.
Offline validation checks only the reference's format. A worker without the
reference leaves the request ready and unclaimed, and shows the reason in its
shared-intake view, until the operator assigns it. If the profile needs instructions-only
adaptation, add `useInstructionsOnly: true` as well.

A preset `definitionRef` in the template is a standard field, so it does not
become required author input. To move an existing template from `definitionId`,
replace that line with `definitionRef` after the operator has assigned the
reference. Requests that workers have already claimed keep their accepted input.

## Customize the team contract

The workflow configuration defaults to:

```json
{
  "schemaVersion": 1,
  "id": "feature-requests",
  "requestsDirectory": "features",
  "reviewDirectory": "feature-reviews",
  "tasksDirectory": "feature-tasks",
  "template": "features/_templates/feature-request.md",
  "base": "Feature Requests.base",
  "readyCheck": "fr-ready-check.json",
  "doneCheck": "fr-done-check.json"
}
```

Paths must be safe repository-relative paths. Requests live directly in the
configured queue; the template lives in a subfolder so it is not itself queued.
Keep review notes and human Tasks separate from intake requests. Omitted
`tasksDirectory` in an older workflow resolves to `<reviewDirectory>/_tasks`;
new setup uses `feature-tasks`. Update the corresponding Base folder filters if
you deliberately change these paths. Review and push workflow changes before
using them with a worker; already accepted requests retain their original paths.

The template has `schemaVersion: 1`, `templateId: feature-request-v1`,
`status: draft`, and `mode: patch`. Keep its four core headings. Additional
headings and custom frontmatter fields become required author input. Preserve
comment-only placeholders for unfinished sections; changing the template ID
requires new drafts to use the matching ID. Existing templates are never silently
replaced by setup. To adapt a legacy template, add the template ID, required
headings, and draft patch frontmatter while retaining your team's instructions.

Check files use the [request gate rule vocabulary](../reference/request-gates.md).
They cannot run commands or grant tools. For example, require at least two
acceptance criteria in `fr-ready-check.json`:

```json
{
  "schemaVersion": 1,
  "id": "fr-ready-check",
  "version": 2,
  "stage": "ready",
  "rules": {
    "chat": [],
    "patch": [
      { "id": "two-criteria", "fact": "input.criteriaCount", "op": "gte", "value": 2 }
    ]
  }
}
```

`fr-done-check.json` has the same shape with `stage: "done"`. Mandatory shared
workflow checks remain in force even when custom arrays are empty. Missing facts
fail closed: requiring `tests.passed` does not let a model statement or a checked
Markdown box stand in for trusted test evidence. The done check is evaluated from
worker-recorded evidence; the offline authoring script does not claim completion.

A worker freezes the request, template, checks, optional definition prompts and
workflow configuration from the accepted Git revision. Later edits to defaults do
not rewrite an in-flight request's rules or accepted input. Review the retained
evidence for that specific request before deciding whether its feature branch
should merge.

### Add definition-of-ready and done prompts

Use optional prompt files for the team's qualitative guidance when the worker
dispatches a Feature Request to its model. Keep machine-evaluated readiness and
completion requirements in `fr-ready-check.json` and `fr-done-check.json`.

1. Create the two files, for example
   `docs/worker/definition-of-ready.md` and
   `docs/worker/definition-of-done.md`.
2. Merge the following fields into the existing `.werk/feature-workflow.json`,
   keeping its required fields and your current folder settings:

   ```json
   {
     "readyPrompt": "docs/worker/definition-of-ready.md",
     "donePrompt": "docs/worker/definition-of-done.md"
   }
   ```

3. Review, commit and push the workflow and prompt files to the worker's watched
   branch before handing off ready requests. The shared-workflow view in the
   webview displays configured paths and digests; changes are made through Git.

Each path is relative to the repository root and must name a distinct ordinary
`.md` or `.txt` file containing nonempty UTF-8 text, at most 64 KiB. Keep prompt
files outside the request, review and Task folders. See the
[prompt contract](../reference/shared-feature-intake.md#optional-definition-prompts)
for path and validation rules. You may configure only one prompt. To stop adding
a definition to future requests, remove its field from the workflow and commit
and push that change; an empty or missing configured file blocks new intake.

A small definition of ready could say:

```markdown
# Definition of ready

Before implementing, check that the accepted request explains the user problem,
expected behavior, approved files and observable acceptance criteria.
If a necessary product decision is missing or contradictory, ask for clarification
through the worker's supported interaction before making that decision yourself.
Stay within the accepted request and the worker's granted capabilities.
```

A definition of done could say:

```markdown
# Definition of done

Implement the accepted criteria and review the changes for edge cases.
Use the configured verification checks available through approved tools.
Summarize changed behavior, observed check results and remaining limitations.
Identify checks that could not run; never describe them as passing.
Request clarification when completion depends on a missing team decision.
Prepare the evidence for human review; completion is not approval to merge.
```

`feature setup` preserves configured prompt files. When a prompt path is already
configured but its file does not yet exist, setup can create an editable starter
there. Setup does not enable definition prompts by default. Review any generated
text before committing it, and refresh the authoring script after a worker upgrade
so offline authors can use the new workflow fields.

The worker pins both configured definitions before claiming a request and supplies
their exact text to the model. The same definitions remain in force when that
request answers a Task, retries, continues its model session or recovers after a
restart. Later prompt edits apply to newly accepted requests. This works for
shared requests authored through Markdown or the webview chat; standalone local
intake without a shared repository binding does not load the workflow file.
Prompts guide the model; deterministic gates and recorded verification still
determine whether the result can advance to review.

### Review requests before implementation

To let the model identify missing decisions before implementation, configure an
optional **Feature Request Ready Check**. This is separate from the `readyPrompt`
and `donePrompt` guidance passed to the implementation model.

Create `docs/worker/feature-request-ready-check.md` with a team review prompt, for
example:

```markdown
# Feature Request Ready Check

Review the request for a clear user problem, expected behavior, approved scope,
observable acceptance criteria and a realistic verification plan.
Identify ambiguous decisions, contradictions and missing information.
Ask focused questions the team can answer; do not invent product decisions.
Do not implement changes or claim that tests passed.
```

Merge this field into your existing `.werk/feature-workflow.json`:

```json
{
  "readyReviewPrompt": "docs/worker/feature-request-ready-check.md"
}
```

Commit and push both files to the watched branch. The prompt must satisfy the
[same bounded file rules](../reference/shared-feature-intake.md#optional-feature-request-ready-check)
as other definition prompts. Setup can create a starter only when the path is
explicitly configured, and preserves existing content. Omitting the field keeps
the Ready Check disabled; removing it affects future claims only.

The worker confirms ownership in shared Git, then reviews the Feature Request
with its selected model. Codex, Claude and API reviews have no tools; Cursor uses
its native read-only ask mode and operator-managed permissions/hooks. Review consumes the worker's normal
allowance and execution capacity. Structurally valid notes can reach this review
before they satisfy semantic completeness and the JSON definition of ready.
A passing review is followed by those deterministic checks before implementation.
The same claimed Feature Request and frozen prompt are used for follow-up rounds;
there is no separate review queue to maintain.

Keep authored Markdown, including frontmatter, YAML comments and team answers,
within 32 KiB of UTF-8 text. Generated progress and reviewer output do not count
toward that authored-input limit when responding. The effective request and
answers must also fit the 8,000-character input budget below. Prompt files have
their own 64 KiB limit. If a long review report is shortened to keep the complete
note publishable, it includes a notice; inspect the full findings in the worker's
shared-request review details. Your answer area is never shortened.

When the worker needs input, continue in the same note:

1. Pull the watched branch and open the original Feature Request. Read the
   generated `## Feature Request Ready Check` findings and questions. Its status
   is `waiting_ready_input` when a team decision is needed.
2. Write the team's responses in the existing `### Answers` area. Revise original
   request details, approved scope or compatible instruction-profile fields where
   necessary, subject to normal validation. Keep the accepted provider, model and
   effort. A different provider or a changed, added or removed model/effort
   override needs a successor request. Adding or removing the provider field is
   allowed only when it still resolves to the accepted provider. Preserve the request ID, template identity, all worker-owned frontmatter and
   generated findings/questions. Keep answers concise: the request, rendered
   metadata and answers together must fit the 8,000-character input budget.
3. Set the note's top-level `status: ready`, commit and push it. A local edit or
   commit alone does not resume the worker. Use your editor for this response;
   the authoring `ready` command does not rewrite worker-owned requests.
4. Pull again to follow `reviewing_ready`. The worker re-reviews substantive
   request or answer changes and either asks for further clarification or checks
   the definition of ready before admitting implementation.

Changing only the status, pushing the same answer again or leaving an unchanged
note in the queue does not start another review. A failed or interrupted review
holds instead of automatically spending allowance on retries. Read the reported
blocker, restore the needed worker configuration or access, and add a substantive
answer or recovery clarification before marking it ready and pushing again.

Once review and deterministic readiness pass, implementation uses frozen input
and the usual progress, Task-answer and PullRequest handoff flow. The Ready Check
cannot grant tools, establish verification facts, skip completion checks or
approve a merge. Human review remains the final decision on the feature branch.
