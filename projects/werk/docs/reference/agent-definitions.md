# Docker Agent definitions in a worker

Workers can import Docker Agent YAML, preview its named agents, and choose one as
an instruction profile for a Feature Request's execution. The selected instructions
and compatible model are passed to the worker's existing provider. Admission
retains an immutable copy of the selection, including the source digest. Answers,
continuations and retries use that copy even if the imported definition is later
removed.

## Import and select

Open **Settings → Agent definitions**. Paste YAML or choose a `.yaml`/`.yml`
file, preview its agents and compatibility notes, then name and import it. Assign
a stable shared reference for use in project requests.

For a shared project, choose the profile in the canonical Feature Request draft:
set `definitionRef` and `agent` in its frontmatter, using **Advanced template
editing** in the webview or your Markdown editor. The connected `feature prepare`
command can seed these fields too. Validate and publish the same request through
shared Git intake; selecting a profile does not start a separate task workflow.
An accepted request keeps its original selection. Use a successor request for
work requiring another profile.

Private workers without a shared repository binding also expose the definition
and named-agent selectors in **New request → Task options**. These local requests
use the same profile snapshot behavior.

For example, this definition supplies an instruction without overriding the
worker's configured model:

```yaml
version: "15"
agents:
  root:
    description: Review a feature before implementation
    instruction: |
      Clarify the requested outcome and identify missing acceptance criteria.
      Propose a small implementation plan and observable verification steps.
      State assumptions and distinguish proposed work from completed work.
```

An inline `model: openai/MODEL_ID` or `model: anthropic/MODEL_ID` selects a model
from that provider family. Replace `MODEL_ID` with a model your account can use.
Named models resolve through the document's `models` mapping. OpenAI definitions
require Codex CLI or OpenAI API; Anthropic definitions require Claude Code CLI or
Anthropic API. Selecting a definition never switches billing or provider families
automatically. CLI authentication still belongs to the worker's OS account.

## Stable references for committed requests

Importing a definition generates a random `definitionId` that exists only in that
worker's private state. Another worker, or the same worker after its state is
recreated, assigns a different ID. Committed request templates, shared Git
requests and scripts that run against several workers should therefore select a
profile by **reference** instead:

```yaml
definitionRef: project-reviewer
agent: root
```

A reference is a name of 1–80 lowercase letters, digits or hyphens, starting with
a letter or digit. The worker operator assigns it to one imported definition on
each worker. References are unique per worker. Give a reference when importing
(`"ref":"project-reviewer"` in the import JSON or the **Shared reference** field
in the webview), or assign it to an existing definition:

```sh
node bin/apps/worker/cli.mjs definition ref --id DEFINITION_ID --ref project-reviewer
```

Assigning a reference that another definition holds moves it; importing a
definition with a reference that is already taken is refused. To update a shared
profile in place, preview the new YAML against the profile and then apply it
with the current revision:

```sh
node bin/apps/worker/cli.mjs definition update --ref project-reviewer --file .werk/agents/project-reviewer.yaml --dry-run
node bin/apps/worker/cli.mjs definition update --ref project-reviewer --file .werk/agents/project-reviewer.yaml --if-match REVISION
```

A `--file` ending in `.yaml` or `.yml` (any case) is read as the YAML profile
itself. Any other `--file` path, or `--file -` for stdin, is JSON
`{"yaml":"YAML_TEXT"}` with an optional `"name"`. `--name NAME` sets the new name
for YAML and JSON input alike; giving both `--name` and a JSON `"name"` is
refused. An omitted name keeps the current one. The update keeps the definition ID,
reference and creation time, and records `updatedAt`. The dry run writes nothing
and reports the current `revision`, the `nextRevision`, any name change, the old
and new digest, and which agents are added, removed or changed (by field:
`description`, `instruction`, `model`, `provider`, `unsupported`). `revision` is
also listed per definition by `definition list`; it binds the definition ID,
shared reference, name and YAML content. Moving the reference invalidates a
previously reviewed revision even when another definition has the same name and
content. A stale revision is refused with `conflict` so a concurrent edit or
reference reassignment cannot redirect the update, and an unknown reference
returns `not_found`. Removing an agent makes
requests that select it fail until they choose another agent.

Updating, moving or removing a reference affects only tasks created afterwards;
existing tasks keep their accepted snapshot, including its digest. To keep the
previous profile available as well, import the new YAML as a separate definition
and move the reference with `definition ref` instead.

Task creation resolves `definitionRef` once, and the task keeps the same immutable
snapshot as an ID selection. The snapshot records the resolved `definitionId`, the
reference and the source digest, so you can tell later which YAML a task used. A
request that names both `definitionRef` and `definitionId` is rejected. When no
definition on the receiving worker holds the reference, task creation fails with
`not_found` and nothing is queued. Local folder intake keeps such a request
waiting with that error and retries it; shared Git intake does not claim it. The adaptation acknowledgement still applies:
a profile with unsupported features also needs `useInstructionsOnly: true`.
Existing `definitionId` requests continue to work unchanged.

The reference is a name, not a content pin. Each worker resolves it to the
definition its operator has assigned, so a team using several workers must import
the same YAML on each one. Compare the `digest` in `definition list` across workers
to confirm they match.

## Compatibility boundary

This integration reads **instruction profiles**, not the full Docker Agent runtime.
It supports named agents, descriptions, string or string-list instructions, and
compatible inline/named model references. Docker schema versions 0–16 are
recognized; unsupported versions require explicit adaptation. YAML must contain
one document. HCL, aliases, anchors and custom tags are not supported.

Preview identifies unsupported fields such as toolsets, hooks, harnesses,
sub-agents, background agents, model parameters and external resources. To use
such a profile, explicitly acknowledge **Use instructions only** after reviewing
the omitted fields. Those features will not run. In particular, this does not
start Docker, MCP servers, shell hooks, remote agents or concurrent sub-agents.
A model from another unsupported provider uses the selected worker connection's
configured model only after adaptation is acknowledged.

Imports do not expand variables, fetch files or contact a registry. Remove
credential/environment fields and `${...}` templates before import. Configure
provider credentials separately in Connections. The worker rejects common
credential literals; this is not a general secret scanner, so review files before
sharing or importing them.

The source YAML is hashed, and normalized profiles are stored privately in
`<worker-state>/agent-definitions.json`; raw YAML is not retained. There are limits
of 32 imported definitions, 24 agents per definition, 16,000 characters per agent
instruction, and 2 MiB total definition storage. YAML input is bounded at 64 KiB;
the complete JSON API/CLI request must also fit the 64 KiB request limit, including
JSON escaping. Large definitions should be reduced to the selected agent's needs.

Every worker still executes one attempt at a time. Profiles do not authorize
filesystem access, grant tools or change execution policy. Operator-configured
tool grants remain separate. With approved repository paths, task-worktree file
access and at least one enabled required check, implementation mode can edit its
isolated worktree, run the required checks and repair failures. Other approved-file
requests retain proposal-only patch generation. Inspect the accepted execution
mode and candidate-bound evidence; see [implement a feature](../how-to/implement-feature.md).
Docker's native session identifiers and multi-agent execution are not imported
into Werk task sessions.

## CLI and API

The portable worker exposes the same workflow to users, CI and AI agents:

```sh
node bin/apps/worker/cli.mjs definition preview --file .werk/agents/project-reviewer.yaml
node bin/apps/worker/cli.mjs definition import --file .werk/agents/project-reviewer.yaml --name "Project reviewer"
node bin/apps/worker/cli.mjs definition list
node bin/apps/worker/cli.mjs definition ref --id DEFINITION_ID --ref project-reviewer
node bin/apps/worker/cli.mjs definition update --ref project-reviewer --file .werk/agents/project-reviewer.yaml --dry-run
node bin/apps/worker/cli.mjs definition delete --id DEFINITION_ID
```

A `.yaml` or `.yml` file is the profile itself; import requires `--name` with it,
and `definition ref` assigns the reference afterwards. The JSON form
`{"name":"Project reviewer","ref":"project-reviewer","yaml":"YAML_TEXT"}` (from another `--file` path or stdin) can also set the optional `ref` in one step; preview
takes `{"yaml":"YAML_TEXT"}`.

For a shared project, prepare the canonical Feature Request with a stable
operation ID and profile reference, for example in `prepare.json`:

```json
{"operationId":"csv-export-draft-001","seed":{"title":"Add CSV export","message":"Export orders as CSV; retain existing access controls.","provider":"codex-cli","paths":["src/orders/export.ts"],"definitionRef":"project-reviewer","agent":"root"}}
```

```sh
node bin/apps/worker/cli.mjs feature prepare --file prepare.json
node bin/apps/worker/cli.mjs feature publish --file publish.json
```

Complete the returned Markdown template and readiness requirements before
publishing. `publish.json` carries the reviewed Markdown, name, a stable operation
ID, `status: "draft"` or `"ready"`, and the `expectedRevision`,
`expectedWorkflowDigest` and `expectedBinding` from preparation. Follow the
[shared authoring contract](feature-requests.md#shared-authoring-api). Only shared
intake claims and dispatches the published ready request.

For an unbound private worker, the compatible `task create --file task.json`
command still accepts the profile selection in direct interaction input:

```json
{"id":"review-001","title":"Review the feature","provider":"codex-cli","definitionRef":"project-reviewer","agent":"root","message":"Review these acceptance criteria: ..."}
```

For that worker-local input, you can instead read the generated definition ID
from import/list and use `"definitionId":"DEFINITION_ID"` in place of
`definitionRef`. Keep stable references in shared project notes.

Where required, add `"useInstructionsOnly":true` after reviewing preview diagnostics.
The CLI derives action names from its commands. Direct HTTP callers use
`GET /api/definitions` or `POST /api/definitions` with `action` set to
`preview`, `import`, `ref` (with `id` and `ref`; an empty `ref` removes the
reference), `update` (with `ref`, `yaml`, optional `name`, and `revision`, or
`"dryRun":true` for a preview) or `delete`. Private task/session and file-task
creation accept `definitionRef` or `definitionId`, plus `agent` and
`useInstructionsOnly`. Local folder and shared Git requests accept those
frontmatter fields; shared authoring seeds support the stable `definitionRef`.
Authenticated browser sessions and bearer-authenticated automation use the same
validation and execution queue. A saved shared binding refuses direct creation,
including while new shared claims are paused; use `feature prepare`/`publish`
for that project.

See [portable applications](portable-apps.md) for state paths and automation,
[the worker guide](../how-to/use-worker-webview.md) for access and provider setup,
and [Docker's configuration reference](https://docs.docker.com/ai/docker-agent/configuration/overview/)
for the full Docker Agent format and runtime capabilities.
