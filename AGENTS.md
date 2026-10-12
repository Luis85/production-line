# The Forge workflow

Read bin/data/README.md and bin/data/docs/reference/cli.md before using the CLI.
Run `node bin/forge.js help` or `node bin/forge.js schema --json` to discover commands.
Environment settings and enabled plugins live in bin/config.json.
Shared templates live in bin/templates and plugins live in bin/plugins.

Run `node bin/forge.js project list` to discover projects, then
`node bin/forge.js project open <id>` to select a project before working on its files.
Check `node bin/forge.js project current` before scoped operations; paths resolve inside the open project.
Run `node bin/forge.js project close` when finished with that project.

Establish acceptance criteria before generating or editing files. Read existing files first,
preview mutations with --dry-run, and supply the current revision with --if-match when replacing files.
Treat conflicts as a request to reread and reconcile. Verify changes with the project's checks.
Keep domain invariants explicit, application use cases dependent on injected ports, and adapters at the edges.
Use clear names and focused functions; verify acceptance criteria and failure behavior with meaningful tests.
Use the installed agent skills in .claude/skills or .agents/skills for the development and file-editing workflows.
Enable only reviewed plugins: plugins execute with Node's permissions.
