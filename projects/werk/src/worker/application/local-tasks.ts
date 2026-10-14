import type { GateInput, WorkerRequest } from "./request-gates.js";
import { DEFAULT_MAX_RUNTIME_MS } from "./execution-policy.js";
import {
  executeModel,
  prepareModelRequest,
  ProviderModelError,
} from "./model-contract.js";
import type { InteractionCommand, InteractionTurn } from "./interactions.js";
import { unknownUsage } from "./run-evidence.js";
import {
  definitionConnection,
  type DefinitionSnapshot,
} from "./definitions.js";
import { randomUUID, createHash } from "node:crypto";
import { join, resolve, relative } from "node:path";
import { realpath, lstat } from "node:fs/promises";
import { object, text } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";
import {
  atomicWrite,
  ensureDirectory,
  readBoundedFile,
} from "../infrastructure/journal/files.js";
import { codexConfiguration } from "../infrastructure/codex-adapter.js";
import { modelFor, type ProviderId } from "../infrastructure/providers.js";
import type { WorkerSettings } from "../infrastructure/settings.js";
import type { WorkerSessions } from "./sessions.js";
import type { ConversationModel } from "./conversation.js";
export interface TaskFile {
  path: string;
  content: string;
  existed: boolean;
}
export interface LocalTask {
  requestId?: string;
  changedFileCount?: number;
  runId?: string;
  currentTurnId?: string;
  submissionHash?: string;
  definition?: DefinitionSnapshot;
  id: string;
  title: string;
  instruction: string;
  sessionId: string;
  provider: ProviderId;
  model: string;
  repository: string;
  files: TaskFile[];
  status:
    | "queued"
    | "running"
    | "review"
    | "failed"
    | "cancelled"
    | "waiting_input"
    | "escalated"
    | "needs_rework";
  priority: number;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  summary: string | null;
  patch: string | null;
  archived: boolean;
}
const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function patchFile(file: TaskFile, content: string) {
  if (file.content === content && file.existed) return "";
  const lines = (value: string, prefix: string) =>
    !value
      ? ""
      : value
          .split("\n")
          .slice(0, value.endsWith("\n") ? -1 : undefined)
          .map(
            (line, index, all) =>
              prefix +
              line +
              "\n" +
              (index === all.length - 1 && !value.endsWith("\n")
                ? "\\ No newline at end of file\n"
                : ""),
          )
          .join("");
  const count = (value: string) =>
    value ? value.split("\n").length - (value.endsWith("\n") ? 1 : 0) : 0;
  const oldCount = count(file.content),
    newCount = count(content);
  return `diff --git ${JSON.stringify("a/" + file.path)} ${JSON.stringify("b/" + file.path)}\n${file.existed ? "" : "new file mode 100644\n"}--- ${file.existed ? JSON.stringify("a/" + file.path) : "/dev/null"}\n+++ ${JSON.stringify("b/" + file.path)}\n@@ -${oldCount ? 1 : 0},${oldCount} +${newCount ? 1 : 0},${newCount} @@\n${lines(file.content, "-")}${lines(content, "+")}`;
}
/** Explicit tasks generate bounded, reviewable patches; provider output is never executed as shell code. */
export class LocalTaskboard {
  private directory: string;
  private settings: WorkerSettings;
  private sessions: WorkerSessions;
  private tasks: LocalTask[] = [];
  private writing = Promise.resolve();
  private running = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private closed = false;
  private persistenceError = false;
  private evidencePersistenceError = false;
  private model: typeof modelFor;
  constructor(
    directory: string,
    settings: WorkerSettings,
    sessions: WorkerSessions,
    model: typeof modelFor = modelFor,
  ) {
    this.directory = directory;
    this.settings = settings;
    this.sessions = sessions;
    this.model = model;
  }
  async init() {
    try {
      const value = JSON.parse(
        await readBoundedFile(join(this.directory, "taskboard.json"), 16777216),
      );
      if (
        !Array.isArray(value) ||
        value.length > 100 ||
        value.some(
          (task) =>
            !task ||
            !/^[a-z0-9-]+$/.test(task.id) ||
            ![
              "queued",
              "running",
              "review",
              "failed",
              "cancelled",
              "waiting_input",
              "escalated",
              "needs_rework",
            ].includes(task.status) ||
            !Array.isArray(task.files),
        )
      )
        throw Error("Invalid taskboard");
      this.tasks = value;
      for (const task of this.tasks) await this.recoverTask(task);
      for (const task of this.tasks) {
        task.sessionId = "local-" + task.id;
        const previous = this.sessions
          .view()
          .records.find((record) => record.id === task.sessionId);
        await this.sessions.ensureTask(
          task.sessionId,
          "local",
          task.title,
          task.provider,
          undefined,
          task.definition,
        );
        this.sessions.protectTask(task.sessionId, true);
        if (
          !previous ||
          previous.taskState !== undefined ||
          task.status === "queued"
        )
          await this.sessions.setTaskState(
            task.sessionId,
            task.status === "review" ? "completed" : task.status,
          );
      }
      await this.persist(this.tasks);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const record of this.sessions.view().records)
      if (
        record.kind === "local" &&
        ["queued", "running"].includes(record.status) &&
        !this.tasks.some((task) => task.sessionId === record.id)
      )
        await this.sessions.setTaskState(record.id, "failed");
  }
  private async reserveRun(task: LocalTask) {
    return (
      await this.sessions.runs.begin({
        sessionId: task.sessionId,
        taskId: task.id,
        kind: "local",
        title: task.title,
        provider: task.provider,
        model: task.model,
        requestId: task.requestId,
        purpose: "execution",
      })
    ).id;
  }
  private gateInput(task: LocalTask): GateInput {
    return {
      kind: "patch",
      title: task.title,
      message: task.instruction,
      files: task.files.map((file) => ({
        path: file.path,
        bytes: Buffer.byteLength(file.content),
        sha256: fingerprint(file.content),
      })),
      context: this.context(task),
    };
  }
  private ensureRequest(task: LocalTask) {
    if (task.requestId) return this.sessions.requests.get(task.requestId);
    const connection = definitionConnection(
      this.settings.provider(task.provider),
      task.definition,
    );
    const actual = this.model(connection, this.directory) as
      | (ConversationModel & {
          configuration?: { id: string; model: string; instruction: string };
        })
      | undefined;
    const profile = actual?.configuration ?? {
      id: connection.id,
      model: task.model,
      instruction: connection.instruction ?? "",
    };
    task.model = profile.model;
    const request = this.sessions.requests.ensure({
      owner: {
        sessionId: task.sessionId,
        rootTurnId: task.id,
        taskId: task.id,
      },
      input: this.gateInput(task),
      provider: profile,
      policy: this.sessions.requestPolicy?.(),
    });
    task.requestId = request.id;
    return request;
  }
  private outputFacts(
    valid: { patch: string; changedFileCount: number } | null,
  ) {
    return {
      "output.protocolValid": !!valid,
      "output.patchPresent": !!valid?.patch,
      "output.changedFileCount": valid?.changedFileCount ?? 0,
    };
  }
  private context(task: LocalTask) {
    return {
      taskId: task.id,
      title: task.title,
      instruction: task.instruction,
      provider: task.provider,
      model: task.model,
      repository: task.repository,
      files: structuredClone(task.files),
      definition: task.definition ?? null,
    };
  }
  private originalPrompt(task: LocalTask) {
    return `Implement the requested changes to the supplied files. Return ONLY a JSON object {"summary":"...","files":[{"path":"approved path","content":"complete new file content"}]}. Do not execute commands. Only include changed approved files. Do not claim tests were run. This creates a patch for human review.\nTask: ${task.title}\nInstruction: ${task.instruction}\nApproved file snapshots: ${JSON.stringify(task.files)}`;
  }
  private preparedRequest(
    task: LocalTask,
    turn: InteractionTurn,
    model: ConversationModel,
  ) {
    const ancestors: InteractionTurn[] = [],
      visited = new Set<string>();
    let priorId = turn.priorTurnId;
    while (priorId) {
      if (visited.has(priorId) || ancestors.length >= 128)
        throw new DomainError(
          "conflict",
          "Saved continuation context is too deep or invalid. Create a new task.",
        );
      visited.add(priorId);
      const previous = this.sessions.interactions.turn(task.sessionId, priorId);
      ancestors.unshift(previous);
      if (previous.dispatch) break;
      priorId = previous.priorTurnId;
    }
    const base = ancestors[0]?.dispatch;
    const messages = base
      ? structuredClone(base.messages)
      : [
          {
            id: task.id,
            role: "user" as const,
            state: "complete" as const,
            at: task.createdAt,
            text: this.originalPrompt(task),
          },
        ];
    for (let index = 0; index < ancestors.length; index++) {
      const previous = ancestors[index];
      // The nearest prepared dispatch already includes its own input. Accepted later
      // answers may have failed before prepare; replay each of those inputs exactly once.
      if (index > 0 || (!base && previous.kind !== "message"))
        messages.push({
          id: previous.id,
          role: "user",
          state: "complete",
          at: previous.createdAt,
          text: previous.input,
        });
      if (previous.result)
        messages.push({
          id: previous.id + "-result",
          role: "assistant",
          state: "complete",
          at: previous.finishedAt ?? previous.createdAt,
          text:
            previous.result.type === "needs_input"
              ? JSON.stringify({ werkInteraction: previous.result.request })
              : previous.result.text,
        });
    }
    if (turn.kind !== "message")
      messages.push({
        id: turn.id,
        role: "user",
        state: "complete",
        at: turn.createdAt,
        text: turn.input,
      });
    const replayModel = base
      ? {
          reply: model.reply.bind(model),
          configuration: structuredClone(base.provider),
        }
      : model;
    return prepareModelRequest(
      task.requestId
        ? ({
            reply: model.reply.bind(model),
            configuration: this.sessions.requests.get(task.requestId).provider,
          } as ConversationModel)
        : replayModel,
      messages,
      "patch",
      this.settings.value.execution.maxRuntimeMs,
    );
  }
  private async prepareTurn(task: LocalTask, turn: InteractionTurn) {
    const connection = {
      ...this.settings.provider(task.provider),
      model: task.model,
    };
    const model = this.model(
      definitionConnection(connection, task.definition),
      this.directory,
    );
    if (!model)
      throw new DomainError(
        "unavailable",
        "Configure this task provider before resuming. The accepted context remains saved.",
      );
    const request = this.ensureRequest(task);
    if (!this.sessions.requests.evaluate(request.id, "ready").passed)
      throw new DomainError(
        "conflict",
        "Readiness is held. Use guarded request rework controls before execution.",
      );
    this.sessions.requests.bindTurn(request.id, turn.id, request.inputRevision);
    task.currentTurnId = turn.id;
    task.runId = await this.reserveRun(task);
    this.sessions.interactions.prepare(
      task.sessionId,
      turn.id,
      this.preparedRequest(task, turn, model),
      task.runId,
    );
    this.sessions.requests.prepareExecution(request.id, turn.id, task.runId);
  }
  private validatedPatch(task: LocalTask, reply: string) {
    if (reply.length > 64000) throw Error("Reply limit");
    const result = JSON.parse(
      reply.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
    );
    if (
      typeof result.summary !== "string" ||
      result.summary.length > 2000 ||
      !Array.isArray(result.files) ||
      !result.files.length ||
      result.files.length > task.files.length ||
      new Set(result.files.map((item: any) => item.path)).size !==
        result.files.length
    )
      throw Error("Invalid change set");
    let patch = "";
    for (const change of result.files) {
      const before = task.files.find((file) => file.path === change.path);
      if (
        !before ||
        typeof change.content !== "string" ||
        change.content.length > 64000 ||
        change.content.includes("\0")
      )
        throw Error("Invalid changed file");
      patch += patchFile(before, change.content);
    }
    if (
      !patch ||
      patch.length > 131072 ||
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/.test(
        patch,
      )
    )
      throw Error("Patch is empty, too large or contains sensitive material");
    return {
      summary: result.summary as string,
      patch,
      changedFileCount: result.files.length as number,
    };
  }
  private async writePatch(task: LocalTask, patch: string) {
    await ensureDirectory(join(this.directory, "local-review"));
    await atomicWrite(
      join(this.directory, "local-review", task.id + ".patch"),
      patch,
    );
  }
  private async recoverTask(task: LocalTask) {
    if (task.requestId) {
      const request = this.sessions.requests.get(task.requestId);
      if (
        !request.execution ||
        request.execution.inputRevision !== request.inputRevision
      ) {
        task.status = "needs_rework";
        task.finishedAt = null;
        task.error =
          "Inspect readiness and execute this accepted request revision explicitly.";
        return;
      }
    }
    const view = this.sessions.interactions.view(task.sessionId);
    const latest = view.latestTurn
      ? this.sessions.interactions.turn(task.sessionId, view.latestTurn.id)
      : null;
    const latestContext = latest?.context as { taskId?: string } | null;
    if (
      latest &&
      (latest.dispatch?.operation === "patch" ||
        latestContext?.taskId === task.id)
    ) {
      task.currentTurnId = latest.id;
      task.runId = latest.runId ?? undefined;
      if (view.phase === "cancelled") {
        task.status = "cancelled";
        task.finishedAt ??= new Date().toISOString();
        task.error ??= "Task cancelled by the operator.";
        return;
      }
    }
    if (task.currentTurnId) {
      const turn = this.sessions.interactions.turn(
        task.sessionId,
        task.currentTurnId,
      );
      if (turn.result?.type === "needs_input") {
        if (task.requestId && turn.runId)
          this.sessions.requests.recordResult(
            task.requestId,
            turn.id,
            turn.runId,
            turn.result,
            this.outputFacts(null),
          );
        task.status =
          turn.result.request.kind === "question"
            ? "waiting_input"
            : "escalated";
        task.finishedAt = null;
        task.error = null;
        task.summary = null;
        task.patch = null;
        return;
      }
      if (turn.result?.type === "completed") {
        const valid = this.validatedPatch(task, turn.result.text);
        if (task.requestId && turn.runId)
          this.sessions.requests.recordResult(
            task.requestId,
            turn.id,
            turn.runId,
            turn.result,
            this.outputFacts(valid),
          );
        await this.writePatch(task, valid.patch);
        Object.assign(task, valid, {
          status: "review",
          finishedAt: turn.finishedAt,
          error: null,
        });
        return;
      }
      if (
        ["queued", "running", "failed", "cancelled", "interrupted"].includes(
          turn.status,
        )
      ) {
        task.status = turn.status === "cancelled" ? "cancelled" : "failed";
        task.finishedAt = turn.finishedAt ?? new Date().toISOString();
        task.error =
          "Worker stopped before this attempt was durably completed. Resume explicitly from its saved context.";
        return;
      }
    }
    if (["queued", "running"].includes(task.status)) {
      task.status = "failed";
      task.error =
        "Worker stopped before execution completed. Resume explicitly; approved inputs are preserved.";
      task.finishedAt = new Date().toISOString();
    }
  }
  private input(task: LocalTask) {
    return (
      task.instruction +
      "\nApproved paths: " +
      task.files.map((file) => file.path).join(", ")
    );
  }
  get active() {
    return this.tasks.filter((task) =>
      ["queued", "running"].includes(task.status),
    ).length;
  }
  view() {
    return {
      settings: { ...this.settings.value.board },
      tasks: this.tasks.map(({ files, instruction, patch, ...task }) => ({
        ...task,
        files: files.map((file) => ({
          path: file.path,
          sha256: fingerprint(file.content),
        })),
        hasPatch: !!patch,
        interaction: this.sessions.interactions.view(task.sessionId),
        ...(task.requestId
          ? {
              requestPhase: this.sessions.requests.get(task.requestId).phase,
              requestRevision: this.sessions.requests.get(task.requestId)
                .revision,
            }
          : {}),
      })),
      persistenceError: this.persistenceError || this.evidencePersistenceError,
      running: this.tasks.filter((task) => task.status === "running").length,
    };
  }
  detail(id: string) {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) throw new DomainError("not_found", "Task not found");
    return {
      ...structuredClone(task),
      interaction: this.sessions.interactions.view(task.sessionId),
    };
  }
  private async persist(tasks: LocalTask[]) {
    const body = JSON.stringify(tasks);
    if (Buffer.byteLength(body) > 16777216)
      throw new DomainError(
        "conflict",
        "Taskboard storage is full. Delete old tasks to free space.",
      );
    await atomicWrite(join(this.directory, "taskboard.json"), body);
    this.persistenceError = false;
  }
  private change(operation: (tasks: LocalTask[]) => void | Promise<void>) {
    const write = this.writing
      .catch(() => {})
      .then(async () => {
        const next = structuredClone(this.tasks);
        await operation(next);
        const changed = next.filter(
          (task) =>
            this.tasks.find((item) => item.id === task.id)?.status !==
            task.status,
        );
        await this.persist(next);
        for (const task of this.tasks)
          if (!next.some((item) => item.id === task.id))
            this.sessions.protectTask(task.sessionId, false);
        this.tasks = next;
        for (const task of changed)
          await this.sessions.setTaskState(
            task.sessionId,
            task.status === "review" ? "completed" : task.status,
          );
      });
    this.writing = write;
    return write;
  }
  async create(input: unknown, submission?: { id: string; hash: string }) {
    if (this.closed) throw new DomainError("unavailable", "Worker is stopping");
    if (submission) {
      if (
        !/^[a-z0-9-]{1,90}$/.test(submission.id) ||
        !/^[a-f0-9]{64}$/.test(submission.hash)
      )
        throw new DomainError(
          "invalid_input",
          "Invalid feature task identity.",
        );
      const existing = this.tasks.find((task) => task.id === submission.id);
      if (existing) {
        if (existing.submissionHash !== submission.hash)
          throw new DomainError(
            "conflict",
            "Task ID belongs to different input.",
          );
        return this.view();
      }
    }
    const body = object(input, "Local task", [
      "title",
      "instruction",
      "repository",
      "paths",
      "priority",
      "provider",
      "definitionId",
      "agent",
      "useInstructionsOnly",
    ]);
    const title = text(body.title, "Title", 200),
      instruction = text(body.instruction, "Instruction", 8000);
    const definition = this.sessions.definitions.select(body);
    const provider = definitionConnection(
      this.settings.provider(
        body.provider === undefined
          ? this.sessions.current.provider
          : String(body.provider),
      ),
      definition,
    );
    const config = codexConfiguration({
      executable: resolve("provider"),
      repository: body.repository,
      allowedPaths: body.paths,
    });
    const repository = await realpath(config.repository),
      files: TaskFile[] = [];
    let bytes = 0;
    for (const path of config.allowedPaths) {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const entry = join(repository, ...parts.slice(0, i));
        const info = await lstat(entry).catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        if (
          info?.isSymbolicLink() ||
          (info && i < parts.length && !info.isDirectory())
        )
          throw new DomainError(
            "invalid_input",
            "Approved files cannot contain symlinks.",
          );
      }
      const absolute = resolve(repository, path);
      if (relative(repository, absolute).startsWith(".."))
        throw new DomainError("invalid_input", "File outside repository");
      let content = "",
        existed = true;
      try {
        content = await readBoundedFile(absolute, 24000);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        existed = false;
      }
      bytes += content.length;
      if (bytes > 48000 || content.includes("\0"))
        throw new DomainError(
          "invalid_input",
          "Task input must be text, at most 48,000 characters in total.",
        );
      files.push({ path, content, existed });
    }
    if (
      body.priority !== undefined &&
      body.priority !== 1 &&
      body.priority !== 2
    )
      throw new DomainError("invalid_input", "Priority must be 1 or 2");
    const id = submission?.id ?? randomUUID();
    const task: LocalTask = {
      ...(submission ? { submissionHash: submission.hash } : {}),
      ...(definition ? { definition } : {}),
      id,
      title,
      instruction,
      sessionId: "local-" + id,
      provider: provider.id,
      model: provider.model,
      repository,
      files,
      status: "queued",
      priority: Number(body.priority ?? 1),
      createdAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      summary: null,
      patch: null,
      archived: false,
    };
    try {
      await this.change(async (tasks) => {
        // Check within the serialized write as concurrent submissions may pass the initial fast path.
        const existing = tasks.find((item) => item.id === id);
        if (existing) {
          if (existing.submissionHash !== submission?.hash)
            throw new DomainError(
              "conflict",
              "Task ID belongs to different input.",
            );
          return;
        }
        if (tasks.length >= 100)
          throw new DomainError(
            "conflict",
            "Taskboard holds 100 tasks. Delete an old task first.",
          );
        if (
          tasks.filter((item) => ["queued", "running"].includes(item.status))
            .length +
            this.sessions.chatActive >=
          this.settings.value.board.queueCapacity
        )
          throw new DomainError("conflict", "Local task queue is full.");
        await this.sessions.ensureTask(
          task.sessionId,
          "local",
          task.title,
          task.provider,
          undefined,
          task.definition,
        );
        this.sessions.protectTask(task.sessionId, true);
        await this.sessions.prepareTask(task.sessionId, this.input(task));
        const request = this.ensureRequest(task);
        if (!this.sessions.requests.evaluate(request.id, "ready").passed) {
          task.status = "needs_rework";
          task.error =
            "Readiness checks did not pass. Inspect open questions, issues and gaps before guarded rework.";
          tasks.push(task);
          return;
        }
        const accepted = this.sessions.interactions.accept({
          sessionId: task.sessionId,
          kind: "message",
          operationId: task.id,
          input: task.instruction,
          context: this.context(task),
        });
        task.currentTurnId = accepted.turn.id;
        if (accepted.duplicate) {
          task.status = "failed";
          task.error =
            "A prior admission was interrupted. Resume explicitly from the retained context.";
          task.finishedAt = new Date().toISOString();
        } else {
          this.sessions.requests.bindTurn(
            request.id,
            accepted.turn.id,
            request.inputRevision,
          );
          try {
            await this.prepareTurn(task, accepted.turn);
          } catch (error) {
            task.status = "failed";
            task.error =
              "Admission did not finish. Inspect the saved context and resume explicitly after configuring the provider.";
            task.finishedAt = new Date().toISOString();
            this.sessions.interactions.fail(
              task.sessionId,
              accepted.turn.id,
              "failed",
              "admission_failed",
            );
            if (task.runId) {
              await this.sessions.runs.finish(task.runId, "failed");
              this.sessions.requests.failExecution(
                request.id,
                accepted.turn.id,
                "failed",
              );
            }
          }
        }
        tasks.push(task);
      });
    } catch (error) {
      if (!this.tasks.some((item) => item.id === id)) {
        if (task.currentTurnId)
          this.sessions.interactions.fail(
            task.sessionId,
            task.currentTurnId,
            "failed",
            "admission_failed",
          );
        if (task.runId)
          await this.sessions.runs.finish(task.runId, "failed").catch(() => {
            this.persistenceError = true;
          });
        this.sessions.protectTask(task.sessionId, false);
        await this.sessions
          .setTaskState(task.sessionId, "failed")
          .catch(() => {});
      }
      throw error;
    }
    if (task.requestId) this.sessions.notifyRequest(task.requestId);
    return this.view();
  }
  async executeRequest(id: string) {
    const request = this.sessions.requests.get(id);
    if (request.owner.remote || request.input.kind !== "patch")
      throw new DomainError(
        "conflict",
        "This request belongs to another execution owner.",
      );
    if (request.execution?.inputRevision === request.inputRevision)
      return this.view();
    if (!this.sessions.requests.evaluate(id, "ready").passed) {
      this.sessions.notifyRequest(id);
      return this.view();
    }
    await this.change(async (tasks) => {
      const task = tasks.find(
        (item) => item.sessionId === request.owner.sessionId,
      );
      if (!task || task.requestId !== id)
        throw new DomainError(
          "not_found",
          "The owning file task is unavailable.",
        );
      if (this.running.has(task.id)) return;
      const current = this.sessions.requests.get(id);
      if (current.execution?.inputRevision === current.inputRevision) return;
      const approved = this.gateInput(task).files;
      if (JSON.stringify(approved) !== JSON.stringify(current.input.files))
        throw new DomainError(
          "conflict",
          "Rework cannot replace the frozen approved file snapshots. Create a new file task for different paths.",
        );
      task.instruction = current.input.message;
      task.title = current.input.title;
      if (current.inputRevision > 1) {
        const previous = this.sessions.interactions.view(task.sessionId);
        if (previous.pending)
          this.sessions.interactions.abandon(
            task.sessionId,
            previous.revision,
            "supersede-" + current.id + "-" + current.inputRevision,
            previous.pending.id,
          );
      }
      const accepted = this.sessions.interactions.accept({
        sessionId: task.sessionId,
        kind: "message",
        operationId: "request-" + id + "-" + current.inputRevision,
        input: task.instruction,
        context: this.context(task),
      });
      if (accepted.duplicate) return;
      await this.prepareTurn(task, accepted.turn);
      Object.assign(task, {
        status: "queued",
        finishedAt: null,
        error: null,
        summary: null,
        patch: null,
        archived: false,
      });
    });
    return this.view();
  }
  async interact(body: InteractionCommand) {
    if (this.closed)
      throw new DomainError("unavailable", "Worker is stopping.");
    let accepted:
        | ReturnType<typeof this.sessions.interactions.accept>
        | undefined,
      taskForFailure: LocalTask | undefined;
    try {
      await this.change(async (tasks) => {
        const task = tasks.find((item) => item.sessionId === body.sessionId);
        if (!task)
          throw new DomainError("not_found", "File-task session not found.");
        const prior =
          body.turnId ??
          this.sessions.interactions.view(task.sessionId).pending?.turnId;
        const request = prior
          ? this.sessions.requests.forTurn(task.sessionId, prior)
          : task.requestId
            ? this.sessions.requests.get(task.requestId)
            : undefined;
        if (
          !this.sessions.interactions.operation(
            task.sessionId,
            body.operationId,
          ) &&
          request &&
          !this.sessions.requests.evaluate(request.id, "ready").passed
        ) {
          this.sessions.notifyRequest(request.id);
          throw new DomainError(
            "conflict",
            "Readiness is held. Use guarded request rework controls before answering or resuming.",
          );
        }
        if (
          request &&
          request.inputRevision > 1 &&
          !request.execution &&
          !this.sessions.interactions.operation(
            task.sessionId,
            body.operationId,
          )
        )
          throw new DomainError(
            "conflict",
            "Request input changed. Execute its accepted revision before continuing an older interaction.",
          );
        if (request) task.requestId = request.id;
        accepted = this.sessions.interactions.accept({
          sessionId: task.sessionId,
          kind: body.action,
          operationId: body.operationId,
          expectedRevision: body.expectedRevision,
          pendingId: body.pendingId,
          priorTurnId: body.turnId,
          input:
            body.action === "answer"
              ? (body.answer ?? "")
              : (body.message ??
                "Resume the saved approved-file task context."),
          context: this.context(task),
        });
        if (accepted.duplicate) return;
        taskForFailure = task;
        if (
          this.running.has(task.id) ||
          tasks.filter((item) => ["queued", "running"].includes(item.status))
            .length +
            this.sessions.chatActive >=
            this.settings.value.board.queueCapacity
        )
          throw new DomainError(
            "conflict",
            "The answer is saved, but the worker queue is full. Resume when capacity is available.",
          );
        await this.prepareTurn(task, accepted.turn);
        Object.assign(task, {
          status: "queued",
          finishedAt: null,
          error: null,
          summary: null,
          patch: null,
          archived: false,
        });
      });
    } catch (error) {
      if (accepted && !accepted.duplicate && taskForFailure) {
        this.sessions.interactions.fail(
          taskForFailure.sessionId,
          accepted.turn.id,
          "failed",
          "admission_failed",
        );
        const failedTurn = this.sessions.interactions.turn(
          taskForFailure.sessionId,
          accepted.turn.id,
        );
        if (failedTurn.runId)
          await this.sessions.runs
            .finish(failedTurn.runId, "failed")
            .catch(() => {
              this.evidencePersistenceError = true;
            });
        // Admission can fail after the answer is durable but before the board publishes it.
        // Project that exact accepted turn without attributing failure to an older run.
        await this.change(async (tasks) => {
          const task = tasks.find(
            (item) => item.sessionId === taskForFailure!.sessionId,
          );
          if (
            !task ||
            this.sessions.interactions.view(task.sessionId).latestTurn?.id !==
              failedTurn.id
          )
            return;
          Object.assign(task, {
            currentTurnId: failedTurn.id,
            runId: failedTurn.runId ?? undefined,
            status: "failed",
            finishedAt: failedTurn.finishedAt,
            error:
              "Accepted input is saved. Resume explicitly when worker capacity is available.",
            summary: null,
            patch: null,
          });
        }).catch(() => {
          this.persistenceError = true;
        });
      }
      throw error;
    }
    return this.sessions.interactions.view(body.sessionId);
  }
  async action(input: unknown, expectedInteractionRevision?: number) {
    const body = object(input, "Task action", ["id", "action", "priority"]);
    const id = String(body.id);
    if (body.action === "retry") {
      const task = this.detail(id);
      if (
        !["failed", "cancelled"].includes(task.status) ||
        this.running.has(id)
      )
        throw new DomainError(
          "conflict",
          "Only stopped or failed tasks can be retried. Answer pending questions through the interaction controls.",
        );
      let view = this.sessions.interactions.view(task.sessionId);
      if (!view.latestTurn) {
        const legacy = this.sessions.interactions.accept({
          sessionId: task.sessionId,
          kind: "message",
          operationId: task.id,
          input: task.instruction,
          context: this.context(task),
        });
        this.sessions.interactions.fail(
          task.sessionId,
          legacy.turn.id,
          "interrupted",
          "legacy_context",
        );
        view = this.sessions.interactions.view(task.sessionId);
      }
      await this.interact({
        action: "resume",
        sessionId: task.sessionId,
        operationId: randomUUID(),
        expectedRevision: view.revision,
        turnId: view.latestTurn!.id,
      });
      return this.view();
    }
    if (body.action === "cancel" && expectedInteractionRevision === undefined)
      this.running.get(id)?.controller.abort();
    await this.change(async (tasks) => {
      const task = tasks.find((item) => item.id === id);
      if (!task) throw new DomainError("not_found", "Task not found");
      if (expectedInteractionRevision !== undefined) {
        const interaction = this.sessions.interactions.view(task.sessionId);
        if (
          interaction.revision !== expectedInteractionRevision ||
          interaction.phase !== "cancelled"
        )
          return;
      }
      if (body.action === "cancel") {
        if (task.status === "queued") {
          task.status = "cancelled";
          task.finishedAt = new Date().toISOString();
          await this.sessions.recordTask(
            task.sessionId,
            this.input(task),
            "Task cancelled before execution.",
            true,
          );
          if (task.currentTurnId)
            this.sessions.interactions.fail(
              task.sessionId,
              task.currentTurnId,
              "cancelled",
              "operator_cancelled",
            );
          if (task.runId)
            await this.sessions.runs.finish(task.runId, "cancelled");
          if (task.requestId && task.currentTurnId)
            this.sessions.requests.failExecution(
              task.requestId,
              task.currentTurnId,
              "cancelled",
            );
        } else if (
          ["waiting_input", "escalated", "needs_rework"].includes(task.status)
        ) {
          if (
            this.sessions.interactions.view(task.sessionId).phase !==
            "cancelled"
          )
            this.sessions.interactions.abandon(task.sessionId);
          task.status = "cancelled";
          task.finishedAt = new Date().toISOString();
          task.error = "Task cancelled while waiting for operator input.";
        } else if (task.status !== "running")
          throw new DomainError("conflict", "Task is no longer active");
      }
      if (body.action === "cancel") {
        if (task.requestId) {
          const request = this.sessions.requests.get(task.requestId);
          if (
            request.phase !== "cancelled" &&
            request.execution?.status !== "running"
          )
            this.sessions.requests.command({
              action: "cancel",
              requestId: request.id,
              expectedRevision: request.revision,
              operationId: "cancel-" + randomUUID(),
            });
        }
      } else if (body.action === "priority") {
        if (task.status !== "queued" || ![1, 2].includes(Number(body.priority)))
          throw new DomainError(
            "invalid_input",
            "Only queued tasks can change priority (1 or 2)",
          );
        task.priority = Number(body.priority);
      } else if (
        body.action === "archive" ||
        body.action === "restore" ||
        body.action === "delete"
      ) {
        if (
          body.action !== "restore" &&
          this.sessions.requests.hasActiveReview(task.sessionId)
        )
          throw new DomainError(
            "conflict",
            "Cancel and drain the request reviewer before archiving or deleting its file task.",
          );
        if (
          ["running", "queued", "waiting_input", "escalated"].includes(
            task.status,
          )
        )
          throw new DomainError(
            "conflict",
            "Stop the task or resolve its pending input first",
          );
        if (body.action === "archive" || body.action === "restore")
          task.archived = body.action === "archive";
        else tasks.splice(tasks.indexOf(task), 1);
      } else throw new DomainError("invalid_input", "Unknown task action");
    });
    return this.view();
  }
  async tick() {
    if (this.closed) return;
    this.sessions.executor.wake();
    if (this.settings.value.board.paused) return;
    const limit = 1;
    for (const task of this.tasks
      .filter((item) => item.status === "queued")
      .sort(
        (a, b) =>
          (this.settings.value.board.order === "priority"
            ? b.priority - a.priority
            : 0) || a.createdAt.localeCompare(b.createdAt),
      )) {
      if (this.running.size >= limit || this.running.has(task.id)) break;
      const controller = new AbortController();
      const promise = this.sessions.executor
        .run(task.sessionId, controller.signal, () =>
          this.execute(task.id, controller),
        )
        .catch(() => {})
        .finally(() => {
          this.running.delete(task.id);
          const finished = this.tasks.find((item) => item.id === task.id);
          if (finished?.requestId)
            this.sessions.notifyRequest(finished.requestId);
        });
      this.running.set(task.id, { controller, promise });
    }
  }
  private async execute(id: string, controller: AbortController) {
    let runId: string | undefined,
      turnId: string | undefined,
      usage = unknownUsage(),
      persistenceFailed = false;
    let outcome:
      | "review"
      | "failed"
      | "cancelled"
      | "waiting_input"
      | "escalated" = "failed";
    let knownResult = false;
    let signal = controller.signal;
    try {
      await this.change((tasks) => {
        const task = tasks.find((item) => item.id === id)!;
        if (task.status !== "queued") throw Error("Task no longer queued");
        task.status = "running";
      });
      const task = this.detail(id);
      runId = task.runId;
      turnId = task.currentTurnId;
      if (!runId || !turnId)
        throw Error("Task has no reserved execution context.");
      const turn = this.sessions.interactions.turn(task.sessionId, turnId);
      if (!turn.dispatch) throw Error("Task request was not durably prepared.");
      const connection = {
        ...this.settings.provider(task.provider),
        model: task.model,
      };
      const model = this.model(
        definitionConnection(connection, task.definition),
        this.directory,
      );
      if (!model) throw Error("Provider not configured");
      signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(
          turn.dispatch.policy.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS,
        ),
      ]);
      signal.throwIfAborted();
      if (task.requestId)
        this.sessions.requests.startExecution(task.requestId, turnId, runId);
      this.sessions.interactions.start(task.sessionId, turnId);
      await this.sessions.runs.start(runId);
      const result = await executeModel(
        model,
        turn.dispatch,
        signal,
        (value) => {
          usage = value;
          try {
            this.sessions.runs.observeUsage(runId!, value);
            this.sessions.interactions.observeUsage(
              task.sessionId,
              turnId!,
              value,
            );
          } catch {
            this.evidencePersistenceError = true;
          }
        },
      );
      signal.throwIfAborted();
      const valid =
        result.type === "completed"
          ? this.validatedPatch(task, result.text)
          : null;
      outcome =
        result.type === "needs_input"
          ? result.request.kind === "question"
            ? "waiting_input"
            : "escalated"
          : "review";
      // Only validated patch completions reach the durable completed state.
      // Questions persist their checkpoint before projections, and release the execution permit.
      this.sessions.interactions.complete(
        task.sessionId,
        turnId,
        result,
        usage,
      );
      knownResult = true;
      if (task.requestId)
        this.sessions.requests.recordResult(
          task.requestId,
          turnId,
          runId,
          result,
          this.outputFacts(valid),
        );
      if (valid && result.type === "completed") {
        await this.writePatch(task, valid.patch);
        await this.change((tasks) => {
          Object.assign(tasks.find((item) => item.id === id)!, valid, {
            status: "review",
            finishedAt: new Date().toISOString(),
            error: null,
          });
        });
        await this.sessions.recordTask(
          task.sessionId,
          this.input(task),
          result.text,
        );
      } else if (result.type === "needs_input") {
        await this.change((tasks) => {
          Object.assign(tasks.find((item) => item.id === id)!, {
            status: outcome,
            finishedAt: null,
            summary: null,
            patch: null,
            error: null,
          });
        });
        await this.sessions.recordTask(
          task.sessionId,
          this.input(task),
          JSON.stringify({ werkInteraction: result.request }),
        );
      }
    } catch (error) {
      const failed = this.tasks.find((task) => task.id === id);
      if (failed && turnId) {
        const saved = this.sessions.interactions.turn(failed.sessionId, turnId);
        if (saved.result) {
          knownResult = true;
          outcome =
            saved.result.type === "completed"
              ? "review"
              : saved.result.request.kind === "question"
                ? "waiting_input"
                : "escalated";
        }
      }
      if (knownResult) persistenceFailed = true;
      else {
        outcome = controller.signal.aborted ? "cancelled" : "failed";
        const code = controller.signal.aborted
          ? "operator_cancelled"
          : signal.aborted
            ? "timeout"
            : error instanceof ProviderModelError
              ? error.code
              : "execution_failed";
        if (failed && turnId) {
          this.sessions.interactions.fail(
            failed.sessionId,
            turnId,
            outcome,
            code,
          );
          if (failed.requestId)
            this.sessions.requests.failExecution(
              failed.requestId,
              turnId,
              outcome,
            );
        }
        const message = controller.signal.aborted
          ? "Task stopped."
          : signal.aborted
            ? "This attempt reached its configured execution time limit. Resume explicitly from saved context to make another attempt."
            : error instanceof ProviderModelError
              ? error.message
              : "Task could not produce a valid patch. Check provider settings and the approved file list, then resume from saved context.";
        if (failed?.status === "running")
          await this.sessions
            .recordTask(failed.sessionId, this.input(failed), message, true)
            .catch(() => {
              persistenceFailed = true;
            });
        await this.change((tasks) => {
          const task = tasks.find((item) => item.id === id);
          if (task && task.status === "running")
            Object.assign(task, {
              status: outcome,
              finishedAt: new Date().toISOString(),
              error: message,
            });
        }).catch(() => {
          persistenceFailed = true;
        });
      }
    }
    // Ledger/projection failure cannot relabel a durably known result or trigger another model call.
    if (runId)
      await this.sessions.runs.finish(runId, outcome, usage).catch(() => {
        this.evidencePersistenceError = true;
      });
    if (persistenceFailed) this.persistenceError = true;
  }
  async close() {
    this.closed = true;
    for (const running of this.running.values()) running.controller.abort();
    await Promise.allSettled(
      [...this.running.values()].map((item) => item.promise),
    );
  }
}
