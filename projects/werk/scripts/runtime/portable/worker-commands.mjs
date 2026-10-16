import { open } from "node:fs/promises";
import { inputError } from "../config.mjs";
// Git fetch, claim and publication can outlast the default 10 s API wait on slow remotes.
const GIT_REQUEST_TIMEOUT_MS = 120000;
export function workerCommands(catalog) {
  catalog["feature setup"] = { local: true, required: [], options: ["project-dir", "features-dir", "if-match"], mutating: true, description: "Install a standalone feature authoring kit without starting or installing a worker; preserve existing project files. The authoring script is refreshed only while it matches the content recorded in .werk/authoring/manifest.json; --if-match REVISION replaces an unrecorded script with that revision." };
  for (const action of ["create", "validate", "ready"]) catalog["feature author " + action] = {
    local: true, required: action === "create" ? ["name", "title"] : ["file", ...(action === "ready" ? ["if-match"] : [])],
    options: ["project-dir"], mutating: action !== "validate",
    description: action === "ready" ? "Validate the current draft and mark it ready using its current SHA-256 revision, without a running worker." : action === "create" ? "Create a draft from the project's standalone authoring kit." : "Validate a request against the project's authoring checks without a worker API.",
  };
  for (const name of ["get", "plan", "set"])
    catalog["feature folder " + name] = {
      local: true,
      required: name === "get" ? [] : ["path"],
      options: ["project-dir"],
      mutating: name === "set",
      description:
        name === "set"
          ? "Persist a project folder change and move requests/results. Stop the worker first; destination must be new."
          : "Inspect or preview the saved project feature-folder path, without a running worker.",
    };
  const action = (
    path,
    action,
    required = ["id"],
    body = false,
    options = [],
    fields = {},
  ) => ({ method: "POST", path, action, required, body, options, fields });
  for (const name of [
    "get",
    "validate",
    "submit",
    "cancel",
    "retry",
    "archive",
    "restore",
    "delete",
    "result",
  ])
    catalog["feature " + name] = action(
      "/api/features",
      name,
      [
        "name",
        ...(["get", "validate", "result"].includes(name) ? [] : ["if-match"]),
      ],
      false,
      [],
      { name: "name", "if-match": "revision" },
    );
  for (const name of ["create", "edit"])
    catalog["feature " + name] = {
      ...action(
        "/api/features",
        name,
        ["name", "markdown", ...(name === "edit" ? ["if-match"] : [])],
        false,
        [],
        { name: "name", "if-match": "revision" },
      ),
      input:
        "Frontmatter + Markdown from --markdown PATH or - (stdin), at most 64 KiB; status: draft.",
    };
  catalog["feature template"] = {
    local: true,
    required: [],
    options: [],
    mutating: false,
    outputFormat: "markdown",
    description:
      "Print an editable draft frontmatter + Markdown request without a running worker. Save it to a file, finish it, then feature create/validate/submit.",
  };
  catalog["definition ref"] = {
    method: "POST", path: "/api/definitions", required: ["id", "ref"], mutating: true,
    description: "Give an imported definition the stable reference that committed requests select with definitionRef. The reference moves from any other definition; existing tasks keep their saved copy.",
  };
  catalog["repository status"] = {
    method: "GET", path: "/api/repositories",
    description: "Inspect assigned repositories and the installation-folder consent request without fetching.",
  };
  catalog["repository sync"] = {
    ...action("/api/repositories", "sync", [], false, ["id"]),
    timeoutMs: GIT_REQUEST_TIMEOUT_MS,
    description: "Fetch assigned repositories and fast-forward clean checkouts; --id selects one assignment.",
  };
  for (const name of ["accept", "decline"])
    catalog["repository " + name] = {
      ...action("/api/repositories", name, ["discovery-id"], false, [], { "discovery-id": "discoveryId" }),
      description: "Record the explicit choice for the exact detected installation repository. Read repository status for its discovery id first.",
    };
  catalog["shared status"] = {
    method: "GET", path: "/api/shared-intake",
    description: "Inspect shared Git intake: binding, current revision, workflow snapshot and request lifecycle, without fetching.",
  };
  catalog["shared sync"] = {
    ...action("/api/shared-intake", "sync", [], false),
    timeoutMs: GIT_REQUEST_TIMEOUT_MS,
    description: "Fetch the shared branch now and reconcile ready requests, claims and publications.",
  };
  catalog["shared configure"] = {
    ...action("/api/shared-intake", "configure", [], true),
    timeoutMs: GIT_REQUEST_TIMEOUT_MS,
    input: "The complete binding is required: enabled, repositoryId, remote, branch, workflowPath and pollMs. Start from the config returned by shared status.",
    example: { expectedRevision: 0, config: { enabled: true, repositoryId: "ASSIGNMENT_ID", remote: "origin", branch: "main", workflowPath: ".werk/feature-workflow.json", pollMs: 60000 } },
    description: "Save the shared intake binding from JSON file/stdin while new starts are paused and idle. Use expectedRevision from shared status; switching branches requires finished, published requests.",
  };
  catalog["profile list"] = {
    method: "GET", path: "/api/execution-profiles",
    description: "Inspect execution profiles, their configuration hash and any pending update.",
  };
  catalog["profile set"] = {
    method: "POST", path: "/api/execution-profiles", body: true,
    example: { expectedConfigurationHash: "Current configurationHash from profile list", profiles: [{ id: "codex-review", provider: "codex", mode: "mock", maxParallel: 1 }] },
    description: "Save execution profiles from JSON file/stdin while the queue is paused and idle. Use the current configuration hash; connected workers synchronize before applying.",
  };
  catalog["consumption status"] = {
    method: "GET", path: "/api/consumption", mutating: false,
    description: "Inspect the configured daily/monthly token allowance, worker share, measured and reserved usage, reset time and admission state. Personal account use outside this worker is not measured.",
  };
  catalog["consumption configure"] = {
    method: "POST", path: "/api/settings", body: true,
    example: { consumption: { enabled: true, period: "daily", allowance: 1000000, workerPercent: 50, perRunReservation: 10000 } },
    description: "Save a consumption policy from JSON file/stdin using the consumption wrapper shown in the example. The worker limits new model invocations; an active invocation can exceed its reservation.",
  };
  catalog["provider list"] = {
    method: "GET",
    path: "/api/settings",
    view: "providers",
    description:
      "List redacted provider configuration; keys and sign-in output are never returned.",
  };
  catalog["provider configure"] = {
    method: "POST",
    path: "/api/settings",
    body: true,
    example: {
      provider: { id: "codex-cli", executable: "/absolute/path/to/codex" },
    },
    description:
      "Save provider settings from private JSON file/stdin; this does not prove sign-in or prompt a model. Use provider check afterward.",
  };
  for (const name of ["status", "plan", "sync"])
    catalog["integrations " + name] = {
      local: true,
      required: [],
      options: [
        "project-dir",
        ...(name === "sync" ? ["if-match", "dry-run"] : []),
      ],
      mutating: name === "sync",
      description:
        name === "sync"
          ? "Apply a reviewed project integration plan with --if-match PLAN_ID; --dry-run returns a read-only plan. Never adopts unowned files or overwrites operator edits."
          : "Inspect recognized Claude/Codex project skills and generated operation guide without a running worker or filesystem writes.",
    };
  for (const name of ["list", "get", "events", "schema", "policy"]) {
    const required = ["get", "events"].includes(name) ? ["id"] : [];
    const options =
      name === "list"
        ? ["session-id", "limit", "offset"]
        : name === "events"
          ? ["after", "limit"]
          : [];
    catalog["request " + name] = {
      ...action("/api/requests", name, required, false, options),
      mutating: false,
      description:
        "Inspect durable worker-owned request gates, policy and events. Unknown rule facts fail closed. Request Done is distinct from model completion and merge.",
    };
  }
  for (const [name, operation] of Object.entries({
    "set-policy": "set_policy",
    evaluate: "evaluate",
    execute: "execute",
    assign: "assign",
    rework: "rework",
    attest: "attest",
    resolve: "resolve_finding",
    propose: "propose",
    accept: "accept_candidate",
    cancel: "cancel",
  })) {
    catalog["request " + name] = {
      ...action(
        "/api/requests",
        operation,
        [...(name === "set-policy" ? [] : ["id"]), "if-match", "key"],
        !["execute", "cancel"].includes(name),
      ),
      mutating: true,
      description:
        "Guarded request command. Use the current request/policy revision and keep --key stable for an uncertain-response retry. JSON --file contains only action-specific fields; original accepted inputs remain retained.",
      example:
        name === "set-policy"
          ? { policy: "Use the full JSON policy returned by request policy." }
          : name === "assign"
            ? { assignee: "llm" }
            : ["evaluate", "rework"].includes(name)
              ? { stage: "ready" }
              : name === "attest"
                ? {
                    inputHash: "current inputHash",
                    outputDigest: "current execution.outputDigest",
                    note: "Explicit operator acceptance of this exact result.",
                  }
                : name === "resolve"
                  ? {
                      findingId: "current finding ID",
                      note: "Decision and supporting context.",
                    }
                  : name === "propose"
                    ? {
                        input:
                          "Copy current input and revise its message; approved files/context stay fixed.",
                      }
                    : name === "accept"
                      ? { candidateId: "pending candidate ID" }
                      : undefined,
    };
  }
  catalog["resource status"] = {
    method: "GET",
    path: "/api/resources",
    mutating: false,
    description:
      "Inspect worker Node RSS/heap/CPU and admission policy. Provider subprocess totals and subscription quotas are not measured.",
  };
  catalog["resource events"] = {
    ...action("/api/resources", "events", [], false, ["after", "limit"]),
    mutating: false,
    description:
      "Read retained resource transitions; follow nextAfter, check gap and oldestAvailableSequence. --after nonnegative sequence, --limit 1–100; default 50.",
  };
  catalog.capabilities = {
    method: "GET",
    path: "/api/capabilities",
    mutating: false,
    description:
      "Discover worker interaction/context capabilities. Configuration and supported adapter behavior do not prove model authentication, quota, or native session resume.",
  };
  catalog["interaction get"] = {
    ...action("/api/interactions", "get"),
    description:
      "Inspect this worker session interaction revision, phase, pending question/escalation, and retained turns; browser selection is unchanged.",
  };
  catalog["interaction turn"] = {
    ...action("/api/interactions", "turn", ["id", "turn-id"]),
    description:
      "Read one retained immutable turn request/result in this session.",
  };
  catalog["interaction events"] = {
    ...action("/api/interactions", "events", ["id"], false, ["after", "limit"]),
    flags: {
      id: "Worker session ID",
      after: "Nonnegative global event sequence; default 0",
      limit: "Integer 1–100; default 50",
    },
    output:
      "{schemaVersion,sessionId,events,nextAfter,hasMore}; durable session-filtered events, no prompt/provider raw content",
    description:
      "Read durable normalized interaction events in sequence order. Pass nextAfter on the next page/poll; empty pages retain the cursor. Polling is supported, token streaming/SSE is not.",
  };
  catalog["interaction answer"] = {
    ...action(
      "/api/interactions",
      "answer",
      ["id", "question-id", "if-match", "key"],
      true,
      ["message"],
    ),
    inputBodyOptional: true,
    example: { answer: "Use the existing page layout." },
    input:
      "Exactly one answer from --message TEXT or JSON --file PATH|- {answer:string}; maximum 8,000 characters.",
    flags: {
      id: "Worker session ID",
      "question-id": "Current pending.id from interaction get",
      "if-match": "Numeric interaction revision from interaction get",
      key: "Stable caller operation ID for replay after an uncertain response",
    },
    description:
      "Durably answer the current pending question. Identical operation ID/input replays the acknowledgement; changed reuse or stale revision conflicts. Admission may wait for capacity.",
  };
  catalog["interaction cancel"] = {
    ...action("/api/interactions", "cancel", [
      "id",
      "question-id",
      "if-match",
      "key",
    ]),
    flags: {
      id: "Worker session ID",
      "question-id": "Current pending.id from interaction get",
      "if-match": "Numeric interaction revision",
      key: "Stable cancellation operation ID",
    },
    description:
      "Decline the current pending question/escalation with revision and replay guards. Running task cancellation remains with its owning task API.",
  };
  catalog["interaction resume"] = {
    ...action(
      "/api/interactions",
      "resume",
      ["id", "turn-id", "if-match", "key"],
      true,
      ["message"],
    ),
    inputBodyOptional: true,
    example: { message: "Continue with the saved context." },
    input:
      "Optional continuation message from --message TEXT or JSON --file PATH|- {message:string}; maximum 8,000 characters.",
    flags: {
      id: "Worker session ID",
      "turn-id": "Prior retained turn ID",
      "if-match": "Numeric interaction revision from interaction get",
      key: "Stable caller operation ID for replay after an uncertain response",
    },
    description:
      "Continue a supported stopped interaction using its explicit retained context. Inspect capability/context mode; this is distinct from retrying the original input.",
  };
  catalog["task resume"] = {
    ...catalog["interaction resume"],
    description:
      "Alias of interaction resume with explicit session/turn/revision/operation ID. Retry remains a separate repeat-input action.",
  };
  const runFields = {
    "session-id": "sessionId",
    "task-id": "taskId",
    provider: "provider",
    kind: "kind",
    purpose: "purpose",
    outcome: "outcome",
    since: "since",
    until: "until",
    limit: "limit",
    offset: "offset",
    cursor: "cursor",
    "as-of": "asOf",
  };
  const runFilters = {
    "session-id": "Worker session ID",
    "task-id": "Owning task ID",
    provider: "codex-cli|claude-cli|openai-api|anthropic-api",
    kind: "chat|local|orchestrator",
    purpose:
      "execution|gate_review|rework; legacy runs without purpose count as execution",
    outcome:
      "queued|running|completed|review|failed|cancelled|interrupted|waiting_input|escalated",
    since: "ISO-8601 timestamp with explicit timezone, inclusive",
    until: "ISO-8601 timestamp with explicit timezone, inclusive",
    limit: "Integer 1–100; default 50",
    offset:
      "Nonnegative integer; prefer returned nextCursor for stable traversal",
    cursor: "Returned nextCursor for the same filters",
    "as-of":
      "Returned nonnegative admission-sequence watermark; not a timestamp",
  };
  for (const name of ["list", "get", "analyze", "export"]) {
    const fields =
      name === "analyze"
        ? Object.fromEntries(
            Object.entries(runFields).filter(
              ([key]) => !["limit", "offset", "cursor"].includes(key),
            ),
          )
        : runFields;
    const filters = Object.fromEntries(
      Object.entries(runFilters).filter(([key]) => key in fields),
    );
    catalog["run " + name] = {
      ...action(
        "/api/runs",
        name,
        name === "get" ? ["id"] : [],
        false,
        name === "get"
          ? []
          : [...Object.keys(fields), ...(name === "export" ? ["format"] : [])],
        name === "get" ? {} : fields,
      ),
      mutating: false,
      filters:
        name === "get"
          ? { id: "Attempt ID from run list" }
          : {
              ...filters,
              ...(name === "export"
                ? { format: "json|csv; default json, stdout only" }
                : {}),
            },
      description:
        name === "get"
          ? "Read one retained worker attempt with its original before/after resource and consumption evidence."
          : name === "analyze"
            ? "Analyze matching retained worker attempts and usage measurement coverage; null tokens/cost are unknown, never zero."
            : "Read a bounded page of retained worker attempts; follow nextCursor until null. JSON export preserves original before/after snapshots; CSV includes them as JSON cells.",
      scope:
        "Worker chat, feature/file tasks and worker-managed follow-ups; original orchestrator lease snapshots remain in history.",
      output:
        name === "get"
          ? "Attempt record"
          : name === "analyze"
            ? "Aggregate evidence with sample/measurement coverage"
            : "{schemaVersion,rows,total,nextOffset,asOf,nextCursor}; no hidden history eviction",
    };
  }
  catalog["task retry"] = action("/api/tasks", "retry");
  for (const name of ["rename", "archive", "restore", "delete"])
    catalog["task " + name] = action(
      "/api/sessions",
      name,
      ["id", ...(name === "rename" ? ["title"] : [])],
      false,
      [],
      { title: "title" },
    );
  catalog["session list"] = { method: "GET", path: "/api/sessions" };
  catalog["session get"] = action("/api/tasks", "get");
  for (const name of ["rename", "archive", "restore", "delete", "select"])
    catalog["session " + name] = action(
      "/api/sessions",
      name,
      ["id", ...(name === "rename" ? ["title"] : [])],
      false,
      [],
      { title: "title" },
    );
  for (const name of [
    "cancel",
    "retry",
    "archive",
    "restore",
    "delete",
    "priority",
  ])
    catalog["file-task " + name] = action(
      "/api/taskboard/action",
      name,
      ["id", ...(name === "priority" ? ["priority"] : [])],
      false,
      [],
      { priority: "priority" },
    );
  catalog["queue get"] = {
    method: "GET",
    path: "/api/sessions",
    description:
      "Serial executor and all session states. queue settings includes capacity and intake settings.",
  };
  catalog["queue settings"] = { method: "GET", path: "/api/settings" };
  for (const name of ["pause", "resume"])
    catalog["queue " + name] = {
      method: "POST",
      path: "/api/settings",
      fixedBody: { board: { paused: name === "pause" } },
      description:
        "Pause/resume execution and new orchestrator claims; running work finishes. Queued work is retained.",
    };
  catalog["queue configure"] = {
    method: "POST",
    path: "/api/settings",
    body: true,
    example: {
      board: { queueCapacity: 16, order: "fifo", orchestratorQueue: 4 },
    },
  };
  catalog["task wait"] = {
    ...action("/api/tasks", "get"),
    wait: "task",
    options: ["timeout-ms"],
  };
  catalog["file-task wait"] = {
    ...action("/api/taskboard/detail", undefined),
    wait: "file-task",
    options: ["timeout-ms"],
  };
  catalog["feature wait"] = {
    ...catalog["feature result"],
    wait: "feature",
    options: ["timeout-ms"],
  };
  for (const name of ["task wait", "file-task wait", "feature wait"]) {
    catalog[name].description =
      "Observe stopped or operator-action state, including waiting_input/escalated. Exit 0 is an observation, not proof of completion. Inspect interaction get for pending input; timeout leaves work running.";
    catalog[name].stopsOn = [
      "completed",
      "review",
      "failed",
      "cancelled",
      "unavailable",
      "waiting_input",
      "escalated",
    ];
  }
  for (const [name, item] of Object.entries(catalog)) {
    if (
      ["task list", "session list", "file-task list", "feature list"].includes(
        name,
      )
    )
      item.options = ["status", "archived"];
    if (item.method === "POST") {
      item.mutating ??=
        item.path !== "/api/runs" &&
        !item.wait &&
        !["get", "turn", "events", "validate", "result"].includes(
          item.action,
        ) &&
        !name.endsWith(" get");
      item.destructive = item.action === "delete";
    }
  }
  return catalog;
}
export async function workerBody(command, body, options) {
  if (command.path === "/api/requests") {
    if (
      body !== undefined &&
      (!body || typeof body !== "object" || Array.isArray(body))
    )
      throw inputError("Request command input must be an object.");
    if (
      body &&
      ["action", "requestId", "expectedRevision", "operationId"].some(
        (key) => key in body,
      )
    )
      throw inputError(
        "Action, target and revision guards come from command flags.",
      );
    const result = { ...body, action: command.action };
    if (options.id) result.requestId = options.id;
    if (options.key) result.operationId = options.key;
    if (options["session-id"]) result.sessionId = options["session-id"];
    for (const [flag, field] of Object.entries({
      "if-match": "expectedRevision",
      after: "after",
      limit: "limit",
      offset: "offset",
    }))
      if (options[flag] !== undefined) {
        const value = Number(options[flag]);
        if (
          !/^\d+$/.test(options[flag]) ||
          !Number.isSafeInteger(value) ||
          value < (flag === "limit" ? 1 : 0) ||
          (flag === "limit" && value > 100)
        )
          throw inputError("Invalid --" + flag + " integer.");
        result[field] = value;
      }
    return result;
  }
  if (command.path === "/api/resources" && command.action === "events") {
    const result = { action: "events" };
    for (const key of ["after", "limit"])
      if (options[key] !== undefined) {
        const n = Number(options[key]),
          min = key === "limit" ? 1 : 0,
          max = key === "limit" ? 100 : Number.MAX_SAFE_INTEGER;
        if (
          !/^\d+$/.test(options[key]) ||
          !Number.isSafeInteger(n) ||
          n < min ||
          n > max
        )
          throw inputError(
            "--" + key + " must be an integer " + min + "–" + max + ".",
          );
        result[key] = n;
      }
    return result;
  }
  if (command.path === "/api/interactions")
    return interactionBody(command, body, options);
  if (command.path === "/api/runs") return workerRunBody(command, options);
  if (command.fixedBody) return command.fixedBody;
  if (command.wait === "file-task") return { id: options.id };
  if (!command.action) return body;
  if (
    body !== undefined &&
    (!body || typeof body !== "object" || Array.isArray(body))
  )
    throw inputError("Command input must be an object.");
  if (body && ("action" in body || "id" in body))
    throw inputError("Action and target come from the command.");
  const result = {
    ...body,
    action: command.action,
    ...(options.id ? { id: options.id } : {}),
  };
  for (const [option, field] of Object.entries(command.fields ?? {}))
    if (options[option] !== undefined) result[field] = options[option];
  if (options.markdown) result.markdown = await readMarkdown(options.markdown);
  return result;
}
export function filterWorkerResult(result, options) {
  if (
    options.archived !== undefined &&
    !["true", "false"].includes(options.archived)
  )
    throw inputError("--archived must be true or false.");
  if (options.status === undefined && options.archived === undefined)
    return result;
  const filter = (rows) =>
    rows.filter(
      (row) =>
        (options.status === undefined || row.status === options.status) &&
        (options.archived === undefined ||
          !!row.archived === (options.archived === "true")),
    );
  return {
    ...result,
    ...(result.records ? { records: filter(result.records) } : {}),
    ...(result.tasks ? { tasks: filter(result.tasks) } : {}),
    ...(result.files ? { files: filter(result.files) } : {}),
  };
}
async function readMarkdown(path) {
  let handle;
  const chunks = [];
  let size = 0;
  try {
    if (path !== "-") {
      handle = await open(path, "r");
      if (!(await handle.stat()).isFile())
        throw inputError("Markdown input must be a regular file.");
    }
    for await (const chunk of handle
      ? handle.createReadStream()
      : process.stdin) {
      size += chunk.length;
      if (size > 65536) throw inputError("Markdown input exceeds 64 KiB.");
      chunks.push(chunk);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } finally {
    await handle?.close();
  }
}

export async function waitForWorker(request, kind, timeoutValue = "60000") {
  const timeout = Number(timeoutValue);
  if (
    !/^\d+$/.test(timeoutValue) ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 86400000
  )
    throw inputError("--timeout-ms must be 1–86400000.");
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await request();
    const state =
      kind === "task"
        ? result.session?.status
        : kind === "file-task"
          ? result.status
          : (result.execution?.status ?? result.record?.status);
    // A feature result combines a durable execution snapshot with an exported
    // record. Completion can land between those reads; wait until its projection
    // also settles before returning a result whose record still says running.
    const projectionPending = kind === "feature" && result.record &&
      ["queued", "running", "waiting", "ready", "readiness"].includes(result.record.status);
    if (!projectionPending &&
      [
        "completed",
        "review",
        "failed",
        "cancelled",
        "unavailable",
        "waiting_input",
        "escalated",
        "needs_rework",
        "interrupted",
        "done",
      ].includes(state)
    )
      return result;
    if (Date.now() >= deadline)
      throw Object.assign(
        Error(
          "Wait timed out; task continues. Inspect it or cancel explicitly.",
        ),
        { code: "wait_timeout" },
      );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1000, deadline - Date.now())),
    );
  }
}

/** Validate evidence selectors before contacting any instance; command flags never become opaque JSON strings. */
function workerRunBody(command, options) {
  const body = {
    action: command.action,
    ...(options.id ? { id: options.id } : {}),
  };
  for (const [option, field] of Object.entries(command.fields ?? {})) {
    const value = options[option];
    if (value === undefined) continue;
    if (["limit", "offset", "as-of"].includes(option)) {
      const n = Number(value),
        minimum = option === "limit" ? 1 : 0,
        maximum = option === "limit" ? 100 : Number.MAX_SAFE_INTEGER;
      if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(n) ||
        n < minimum ||
        n > maximum
      )
        throw inputError(
          "--" +
            option +
            " must be an integer " +
            minimum +
            "–" +
            maximum +
            ".",
        );
      body[field] = n;
    } else if (["since", "until"].includes(option)) {
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          value,
        ) ||
        !Number.isFinite(Date.parse(value))
      )
        throw inputError(
          "--" +
            option +
            " must be an ISO timestamp with an explicit timezone.",
        );
      body[field] = new Date(value).toISOString();
    } else {
      const choices = {
        provider: ["codex-cli", "claude-cli", "openai-api", "anthropic-api"],
        kind: ["chat", "local", "orchestrator"],
        purpose: ["execution", "gate_review", "rework"],
        outcome: [
          "queued",
          "running",
          "completed",
          "review",
          "failed",
          "cancelled",
          "interrupted",
          "waiting_input",
          "escalated",
        ],
      }[option];
      if (choices && !choices.includes(value))
        throw inputError("--" + option + " must be " + choices.join("|") + ".");
      if (
        !value ||
        value.length > (option === "cursor" ? 4096 : 200) ||
        /[\x00-\x1f]/.test(value)
      )
        throw inputError("Invalid --" + option + ".");
      body[field] = value;
    }
  }
  if (
    body.since &&
    body.until &&
    Date.parse(body.since) > Date.parse(body.until)
  )
    throw inputError("--since must not be after --until.");
  if (options.format !== undefined && !["json", "csv"].includes(options.format))
    throw inputError("--format must be json or csv.");
  if (
    options.cursor !== undefined &&
    (options.offset !== undefined || options["as-of"] !== undefined)
  )
    throw inputError("--cursor cannot be combined with --offset or --as-of.");
  return body;
}
export function workerOutput(result, options, command) {
  if (command?.view === "providers")
    return JSON.stringify({ providers: result.providers });
  if (
    command?.path !== "/api/runs" ||
    command.action !== "export" ||
    options.format !== "csv"
  )
    return JSON.stringify(filterWorkerResult(result, options));
  if (!Array.isArray(result.rows))
    throw Error("Worker returned no readable run export page.");
  const headers = [
    "id",
    "sessionId",
    "taskId",
    "kind",
    "title",
    "provider",
    "model",
    "attempt",
    "sequence",
    "outcome",
    "acceptedAt",
    "startedAt",
    "durationMs",
    "queueDurationMs",
    "usage",
    "resourceDelta",
    "before",
    "after",
    "schemaVersion",
    "total",
    "asOf",
    "nextOffset",
    "nextCursor",
    "purpose",
    "requestId",
  ];
  const cell = (value) => {
    if (value == null) return "";
    if (typeof value === "number") return String(value);
    let text =
      typeof value === "object" ? JSON.stringify(value) : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text; // Keep spreadsheet imports from executing formula-like text.
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return [
    headers.join(","),
    ...result.rows.map((row) =>
      headers
        .map((header) =>
          cell(
            ["total", "asOf", "nextOffset", "nextCursor"].includes(header)
              ? result[header]
              : row[header],
          ),
        )
        .join(","),
    ),
  ].join("\r\n");
}

function interactionBody(command, body, options) {
  if (
    body !== undefined &&
    (!body || typeof body !== "object" || Array.isArray(body))
  )
    throw inputError("Interaction input must be a JSON object.");
  const contentField = command.action === "answer" ? "answer" : "message";
  if (body && Object.keys(body).some((field) => field !== contentField))
    throw inputError(
      "Interaction input accepts only " +
        contentField +
        "; target, revision and operation ID come from command flags.",
    );
  const identifier = (value, flag) => {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
      throw inputError(
        "Invalid --" +
          flag +
          "; use 1–100 letters, digits, underscores or hyphens.",
      );
    return value;
  };
  const result = {
    action: command.action,
    sessionId: identifier(options.id, "id"),
  };
  if (command.action === "events") {
    for (const flag of ["after", "limit"]) {
      if (options[flag] === undefined) continue;
      const value = options[flag],
        numeric = Number(value),
        minimum = flag === "limit" ? 1 : 0,
        maximum = flag === "limit" ? 100 : Number.MAX_SAFE_INTEGER;
      if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(numeric) ||
        numeric < minimum ||
        numeric > maximum
      )
        throw inputError(
          "--" + flag + " must be an integer " + minimum + "–" + maximum + ".",
        );
      result[flag] = numeric;
    }
    return result;
  }
  if (options["turn-id"] !== undefined)
    result.turnId = identifier(options["turn-id"], "turn-id");
  if (options["question-id"] !== undefined)
    result.pendingId = identifier(options["question-id"], "question-id");
  if (["answer", "resume", "cancel"].includes(command.action)) {
    const revision = options["if-match"];
    if (
      typeof revision !== "string" ||
      !/^\d+$/.test(revision) ||
      !Number.isSafeInteger(Number(revision))
    )
      throw inputError(
        "--if-match must be a nonnegative numeric interaction revision.",
      );
    result.expectedRevision = Number(revision);
    result.operationId = identifier(options.key, "key");
    if (command.action === "cancel") return result;
    if (options.message !== undefined && body?.[contentField] !== undefined)
      throw inputError("Choose --message or --file, not both.");
    const message = options.message ?? body?.[contentField];
    if (
      message !== undefined &&
      (typeof message !== "string" || !message.trim() || message.length > 8000)
    )
      throw inputError(contentField + " must contain 1–8,000 characters.");
    if (command.action === "answer" && message === undefined)
      throw inputError("Supply an answer using --message or --file.");
    if (message !== undefined) result[contentField] = message;
  }
  return result;
}
