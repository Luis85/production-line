# Docker Agent definitions in a worker

Workers can import Docker Agent YAML, preview its named agents, and choose one as
an instruction profile for a task. The selected instructions and compatible model
are passed to the worker's existing provider. Each task retains an immutable copy
of the selection, including the source digest. Follow-ups and retries use that
copy even if the imported definition is later removed.

## Import and select

From Chat, open the agent definitions editor. Paste YAML or choose a `.yaml`/`.yml`
file, preview its agents and compatibility notes, then name and import it. Before
starting a new task, choose the definition and named agent together with the
worker provider. An existing task keeps its original selection; start a new task
to use another agent. Explicit file tasks can also choose an agent profile.

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

Every worker still executes exactly one task at a time. Profiles do not authorize
filesystem access or change execution policy. Chat has no repository tools;
explicit file tasks use approved snapshots and produce a review patch without
applying changes or running tests. Docker's own native session identifiers and
multi-agent execution are not imported into Werk task sessions.

## CLI and API

The portable worker exposes the same workflow to users, CI and AI agents:

```sh
node bin/apps/worker/cli.mjs definition preview --file .werk/agents/project-reviewer.yaml
node bin/apps/worker/cli.mjs definition import --file .werk/agents/project-reviewer.yaml --name "Project reviewer"
node bin/apps/worker/cli.mjs definition list
node bin/apps/worker/cli.mjs definition ref --id DEFINITION_ID --ref project-reviewer
node bin/apps/worker/cli.mjs definition update --ref project-reviewer --file .werk/agents/project-reviewer.yaml --dry-run
node bin/apps/worker/cli.mjs task create --file task.json
node bin/apps/worker/cli.mjs definition delete --id DEFINITION_ID
```

A `.yaml` or `.yml` file is the profile itself; import requires `--name` with it,
and `definition ref` assigns the reference afterwards. The JSON form
`{"name":"Project reviewer","ref":"project-reviewer","yaml":"YAML_TEXT"}` (from another `--file` path or stdin) can also set the optional `ref` in one step; preview
takes `{"yaml":"YAML_TEXT"}`. Select the definition in task input by its reference:

```json
{"id":"review-001","title":"Review the feature","provider":"codex-cli","definitionRef":"project-reviewer","agent":"root","message":"Review these acceptance criteria: ..."}
```

Alternatively, read the generated definition ID from the import/list response and
use `"definitionId":"DEFINITION_ID"` in place of `definitionRef`.

Where required, add `"useInstructionsOnly":true` after reviewing preview diagnostics.
The CLI derives action names from its commands. Direct HTTP callers use
`GET /api/definitions` or `POST /api/definitions` with `action` set to
`preview`, `import`, `ref` (with `id` and `ref`; an empty `ref` removes the
reference), `update` (with `ref`, `yaml`, optional `name`, and `revision`, or
`"dryRun":true` for a preview) or `delete`. Task/session creation and file-task creation accept
`definitionRef` or `definitionId`, plus `agent` and `useInstructionsOnly`. Local
folder and shared Git feature requests accept the same frontmatter fields. Authenticated browser sessions
and bearer-authenticated automation use the same validation and task queue.

See [portable applications](portable-apps.md) for state paths and automation,
[the worker guide](../how-to/use-worker-webview.md) for access and provider setup,
and [Docker's configuration reference](https://docs.docker.com/ai/docker-agent/configuration/overview/)
for the full Docker Agent format and runtime capabilities.
