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

Use `--features-dir requests/features` to choose a different queue and
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

The JSON result includes `valid`, errors, deterministic rule results, and the
file's `revision`. Invalid requests return exit code 2. Resolve missing sections,
approved paths, template requirements, and configured rule failures, then validate
again. Validation reads the current template and both check files; it does not
contact a worker or change the request.

## Explicitly queue the request

When you intend the worker to pick up this work, copy the revision from successful
validation into this command:

```sh
node .werk/authoring/feature-request.mjs ready --file features/search.md --if-match REVISION
```

Readiness checks run again against the current file and rules before `draft`
changes to `ready`. A stale revision requires reading and validating the changed
file. Commit the ready request and use your normal Git review and push workflow.
Creating or validating a draft does not queue it. Neither a local save nor a
local commit dispatches shared work. A connected worker can claim the ready
request only after its commit is pushed to the watched remote branch.

Once a worker owns a request, leave its lifecycle metadata and original input
alone. The authoring script rejects readiness mutations of worker-owned or already
queued files. Use a successor draft for changed work and retain the original ID
with its history. Human review is still required before merging implementation
changes; a worker publication or completion check is not a merge approval.

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
Keep its accepted body and worker-owned fields unchanged. A linked **Task** with
`action: answer` or `action: resume` is the supported response channel:

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
node bin/apps/worker/cli.mjs definition update --ref project-reviewer --file update.json --dry-run
node bin/apps/worker/cli.mjs definition update --ref project-reviewer --file update.json --if-match REVISION
```

`update.json` contains `{"yaml":"YAML_TEXT"}`. Tasks created earlier keep the
profile they accepted; later tasks use the update.
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

A worker freezes the request, template, checks, and workflow configuration from
the accepted Git revision. Later edits to defaults do not rewrite an in-flight
request's rules or accepted input. Review the retained evidence for that specific
request before deciding whether its feature branch should merge.
