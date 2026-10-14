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
node bin/apps/worker/cli.mjs definition preview --file preview.json
node bin/apps/worker/cli.mjs definition import --file definition.json
node bin/apps/worker/cli.mjs definition list
node bin/apps/worker/cli.mjs task create --file task.json
node bin/apps/worker/cli.mjs definition delete --id DEFINITION_ID
```

`preview.json` contains `{"yaml":"YAML_TEXT"}`. `definition.json` contains
`{"name":"Project reviewer","yaml":"YAML_TEXT"}`. Read the generated definition
ID from the import/list response and use it in task input:

```json
{"id":"review-001","title":"Review the feature","provider":"codex-cli","definitionId":"DEFINITION_ID","agent":"root","message":"Review these acceptance criteria: ..."}
```

Where required, add `"useInstructionsOnly":true` after reviewing preview diagnostics.
The CLI derives action names from its commands. Direct HTTP callers use
`GET /api/definitions` or `POST /api/definitions` with `action` set to
`preview`, `import` or `delete`. Task/session creation and file-task creation accept
`definitionId`, `agent` and `useInstructionsOnly`. Authenticated browser sessions
and bearer-authenticated automation use the same validation and task queue.

See [portable applications](portable-apps.md) for state paths and automation,
[the worker guide](../how-to/use-worker-webview.md) for access and provider setup,
and [Docker's configuration reference](https://docs.docker.com/ai/docker-agent/configuration/overview/)
for the full Docker Agent format and runtime capabilities.
