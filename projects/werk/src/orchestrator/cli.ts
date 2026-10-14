#!/usr/bin/env node
import { args, validateOptions, integer, input, fail } from "../shared/cli.js";
import { request } from "../shared/http/client.js";
import { DomainError } from "../shared/errors.js";
const help = `werk-orchestrator — SQLite server and headless client

serve [--host 127.0.0.1] [--port 3000|0] [--db .state/factory.sqlite] [--project demo]
    [--context-repo PATH --context-commit FULL_SHA --context-vault-root docs]
iteration import --repo PATH --branch iteration/2026-W42 --project demo --iteration 2026-W42
    --iteration-pr https://git.example/project/pull/10 [--features docs/features] [--dry-run true]
    [--context pinned --vault-root docs] (server-bound commit; PR URL remains unverified)
context resolve --repo PATH --commit FULL_SHA --vault-root docs --project demo --wikilink "[[Features/Feature]]"
task create --file <path|-> --key <stable-idempotency-key> [--url http://127.0.0.1:3000]
task create --project ID --wikilink '[[Features/Feature]]' --key <stable-idempotency-key> [--url URL]
task successor --id TASK --attempt N --evaluation GATE_EVALUATION --key OP --file <path|-> [--url URL]
task list [--limit 1..1000] [--cursor CURSOR] [--url URL]
task get --id <task-id> [--url URL]
task context --id <task-id> [--url URL] (admin-only pinned manifest; contains source text)
task events --id <task-id> [--limit 1..1000] [--cursor CURSOR] [--url URL]
workers list [--limit 1..1000] [--cursor CURSOR] [--url URL]
snapshots list [--project ID] [--worker ID] [--task ID] [--order asc|desc] [--after CURSOR | --before CURSOR] [--limit 500] [--url URL]
health [--url URL]
overview [--url URL]
monitoring [--url URL] (read-only operational metrics and alerts)
mcp serve [--url URL] [--allow-writes true|false] (MCP stdio; read-only by default)
--help

JSON on stdout; logs/errors on stderr. Exit 0 success, 2 input/API 4xx, 1 other error.
Use WERK_ADMIN_TOKEN and WERK_ENROLLMENT_TOKEN (distinct, >=24 chars).
Client commands use WERK_ADMIN_TOKEN and WERK_URL. No direct DB access from client commands.
Execution remains mock. Server context binding opts requirement intake into commit-pinned resolution; otherwise references remain unresolved. context resolve is a separate local preview.`;
try {
  const { commands, options: o } = args(),
    cmd = commands.join(" ");
  if (o.help || !cmd) console.log(help);
  else if (cmd === "mcp serve") {
    validateOptions(o, ["url", "allow-writes"]);
    const { serveWerkMcp } = await import("../shared/mcp/stdio.js");
    await serveWerkMcp("orchestrator", o);
  } else if (cmd === "context resolve") {
    validateOptions(o, ["repo", "commit", "vault-root", "wikilink", "project"]);
    const { resolveContextCommand } = await import("./context/command.js");
    console.log(JSON.stringify(await resolveContextCommand(o)));
  } else if (cmd === "iteration import") {
    validateOptions(o, [
      "repo",
      "branch",
      "project",
      "iteration",
      "iteration-pr",
      "features",
      "dry-run",
      "url",
      "context",
      "vault-root",
    ]);
    const { importIteration } = await import("./intake/importer.js");
    const result = await importIteration(o, process.env.WERK_ADMIN_TOKEN ?? "");
    console.log(JSON.stringify(result));
    if ("requiresDecision" in result && result.requiresDecision)
      process.exitCode = 2;
  } else if (cmd === "serve") {
    validateOptions(o, [
      "host",
      "port",
      "db",
      "project",
      "context-repo",
      "context-commit",
      "context-vault-root",
    ]);
    const contextKeys = [
      "context-repo",
      "context-commit",
      "context-vault-root",
    ];
    const hasContext = contextKeys.some((key) => o[key] !== undefined);
    if (hasContext && contextKeys.some((key) => !o[key]))
      throw new DomainError(
        "invalid_input",
        "Set all three context binding flags together",
      );
    const context = hasContext
      ? {
          repo: o["context-repo"],
          commit: o["context-commit"],
          vaultRoot: o["context-vault-root"],
        }
      : undefined;
    const { startServer } = await import("./server.js");
    const app = await startServer({
      host: o.host ?? "127.0.0.1",
      port: integer(o.port ?? "3000", "port", 0, 65535),
      db: o.db ?? ".state/factory.sqlite",
      project: o.project ?? "demo",
      adminToken: process.env.WERK_ADMIN_TOKEN ?? "",
      enrollmentToken: process.env.WERK_ENROLLMENT_TOKEN ?? "",
      context,
    });
    console.error(
      JSON.stringify({
        event: "listening",
        address: app.server.address(),
        mode: "mock",
        context: context ? "pinned" : "unresolved",
      }),
    );
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      await app.close();
    };
    process.on("SIGTERM", () => void stop().catch(fail));
    process.on("SIGINT", () => void stop().catch(fail));
  } else {
    const optionsByCommand: Record<string, string[]> = {
      "task successor": ["url", "id", "attempt", "evaluation", "key", "file"],
      "task create": ["url", "file", "key", "project", "wikilink"],
      "task list": ["url", "limit", "cursor"],
      "task get": ["url", "id"],
      "task context": ["url", "id"],
      "task events": ["url", "id", "limit", "cursor"],
      "workers list": ["url", "limit", "cursor"],
      "snapshots list": [
        "url",
        "project",
        "worker",
        "task",
        "after",
        "before",
        "order",
        "limit",
      ],
      health: ["url"],
      overview: ["url"],
      monitoring: ["url"],
    };
    if (!optionsByCommand[cmd])
      throw new DomainError("invalid_input", "Unknown command. Use --help.");
    validateOptions(o, optionsByCommand[cmd]);
    const base = o.url ?? process.env.WERK_URL ?? "http://127.0.0.1:3000",
      token = process.env.WERK_ADMIN_TOKEN ?? "";
    const pageParameters = new URLSearchParams();
    if (["task list", "task events", "workers list"].includes(cmd)) {
      if (o.limit !== undefined)
        pageParameters.set("limit", String(integer(o.limit, "limit", 1, 1000)));
      if (o.cursor !== undefined) pageParameters.set("cursor", o.cursor);
    }
    const pageSuffix = pageParameters.size ? "?" + pageParameters : "";
    let result: unknown;
    if (cmd === "task create") {
      if (!o.key)
        throw new DomainError("invalid_input", "task create requires --key");
      const fromNote = o.wikilink !== undefined || o.project !== undefined;
      if ((o.file !== undefined && fromNote) || (!o.file && !fromNote))
        throw new DomainError(
          "invalid_input",
          "Use either --file or --project with --wikilink",
        );
      if (fromNote && (!o.project || !o.wikilink))
        throw new DomainError(
          "invalid_input",
          "Vault intake requires --project and --wikilink",
        );
      const payload = fromNote
        ? { project: o.project, requirementRef: o.wikilink }
        : await input(o.file);
      result = await request(base, "/v1/tasks", token, "POST", payload, o.key);
    } else if (cmd === "task successor") {
      if (!o.id || !o.attempt || !o.evaluation || !o.key || !o.file)
        throw new DomainError(
          "invalid_input",
          "task successor requires --id, --attempt, --evaluation, --key and --file.",
        );
      const payload = {
        expectedAttempt: integer(
          o.attempt,
          "attempt",
          1,
          Number.MAX_SAFE_INTEGER,
        ),
        evaluationId: o.evaluation,
        operationId: o.key,
        input: await input(o.file),
      };
      result = await request(
        base,
        "/v1/tasks/" + encodeURIComponent(o.id) + "/successor",
        token,
        "POST",
        payload,
        o.key,
      );
    } else if (cmd === "task list")
      result = await request(base, "/v1/tasks" + pageSuffix, token);
    else if (
      cmd === "task get" ||
      cmd === "task events" ||
      cmd === "task context"
    ) {
      if (!o.id) throw new DomainError("invalid_input", "--id is required");
      result = await request(
        base,
        "/v1/tasks/" +
          encodeURIComponent(o.id) +
          (cmd === "task events"
            ? "/events" + pageSuffix
            : cmd === "task context"
              ? "/context"
              : ""),
        token,
      );
    } else if (cmd === "workers list")
      result = await request(base, "/v1/workers" + pageSuffix, token);
    else if (cmd === "snapshots list") {
      const q = new URLSearchParams();
      for (const k of [
        "project",
        "worker",
        "task",
        "after",
        "before",
        "order",
        "limit",
      ])
        if (o[k]) q.set(k, o[k]);
      result = await request(base, "/v1/snapshots?" + q, token);
    } else if (cmd === "health") result = await request(base, "/healthz", "");
    else if (cmd === "monitoring")
      result = await request(base, "/v1/monitoring", token);
    else if (cmd === "overview")
      result = await request(base, "/v1/overview", token);
    else throw new DomainError("invalid_input", "Unknown command. Use --help.");
    console.log(JSON.stringify(result));
  }
} catch (error) {
  fail(error);
}
