import {
  successorCommand,
  canonicalValue,
  type SuccessorCommand,
  type SuccessorReceipt,
} from "../intake/successor.js";
import { randomUUID } from "node:crypto";
import { taskInput } from "../../shared/contracts.js";
import type { Task } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";
import type { WorkerRecord } from "../../shared/protocol.js";
import { CONTEXT_MANIFEST_MAX_BYTES, type ContextManifest } from "../../shared/context.js";
import type { StoreSession } from "./session.js";
import { hash } from "./digest.js";

/** Atomic task intake, pinned context and successor receipts. */
export class TaskIntakeRepository {
  private readonly session: StoreSession;

  constructor(session: StoreSession) {
    this.session = session;
  }

  /** Original normalized intake identifies retries, independently of any current repository binding. */
  submission(value: unknown, key: string): Task | undefined {
    const data = taskInput(value),
      digest = hash(JSON.stringify(data));
    if (typeof key !== "string" || !/^[\w:.-]{1,128}$/.test(key))
      throw new DomainError(
        "invalid_input",
        "Idempotency-Key required: 1–128 letters, digits, _, :, . or -",
      );
    const existing = this.session.db
      .prepare("SELECT * FROM tasks WHERE idem=?")
      .get(key) as any;
    if (!existing) return undefined;
    if (existing.digest !== digest)
      throw new DomainError(
        "conflict",
        "Idempotency key already used for a different task",
      );
    return this.session.decode(existing);
  }
  submit(value: unknown, key: string): Task {
    const data = taskInput(value);
    return this.session.transaction(() => {
      const existing = this.submission(value, key);
      if (existing) return existing;
      return this.insertSubmission(data, key);
    });
  }
  private insertSubmission(
    data: ReturnType<typeof taskInput>,
    key: string,
  ): Task {
    const id = randomUUID();
    this.session.db
      .prepare(
        "INSERT INTO tasks(id,payload,status,priority,created,idem,digest) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        JSON.stringify(data),
        "queued",
        data.priority,
        this.session.clock(),
        key,
        hash(JSON.stringify(data)),
      );
    this.session.event(id, "submitted", {
      contextStatus: "unresolved",
      provider: data.provider,
    });
    return this.session.get(id);
  }
  submitResolved(value: unknown, key: string, manifest: ContextManifest): Task {
    const original = taskInput(value);
    return this.session.transaction(() => {
      // A concurrent resolver may have committed while Git was being read; never repin its result.
      const existing = this.submission(value, key);
      if (existing) return existing;
      return this.insertResolved(original, key, manifest);
    });
  }
  private insertResolved(
    original: ReturnType<typeof taskInput>,
    key: string,
    manifest: ContextManifest,
  ): Task {
    const { sha256, ...body } = manifest;
    if (
      manifest.project !== original.project ||
      manifest.requirement.wikilink !== original.requirementRef ||
      sha256 !== hash(JSON.stringify(body))
    )
      throw new DomainError(
        "invalid_input",
        "Context manifest does not match intake",
      );
    const encoded = JSON.stringify(manifest);
    if (Buffer.byteLength(encoded, "utf8") > CONTEXT_MANIFEST_MAX_BYTES)
      throw new DomainError(
        "too_large",
        "Serialized context manifest exceeds byte limit",
      );
    const derived = taskInput({
      ...original,
      title: manifest.requirement.title,
      criteria: manifest.requirement.acceptance,
    });
    const context = {
      sha256,
      commit: manifest.commit,
      featureId: manifest.requirement.featureId,
      path: manifest.requirement.path,
    };
    const id = randomUUID();
    this.session.db
      .prepare(
        "INSERT INTO tasks(id,payload,status,priority,created,idem,digest) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        JSON.stringify({ ...derived, context }),
        "queued",
        derived.priority,
        this.session.clock(),
        key,
        hash(JSON.stringify(original)),
      );
    this.session.db
      .prepare("INSERT INTO task_contexts(task,sha256,payload) VALUES(?,?,?)")
      .run(id, sha256, encoded);
    this.session.event(id, "submitted", {
      contextStatus: "pinned",
      contextManifestHash: sha256,
      provider: derived.provider,
    });
    return this.session.get(id);
  }
  successorSubmission(
    parentId: string,
    value: SuccessorCommand,
  ): SuccessorReceipt | undefined {
    const command = successorCommand(value),
      digest = hash(canonicalValue(command));
    const existing = this.session.db
      .prepare(
        "SELECT digest,child FROM task_successors WHERE parent=? AND operation_id=?",
      )
      .get(parentId, command.operationId);
    if (existing) {
      if (existing.digest !== digest)
        throw new DomainError(
          "conflict",
          "Successor operation already belongs to different input.",
        );
      return {
        task: this.session.get(String(existing.child)),
        parentTaskId: parentId,
        duplicate: true,
      };
    }
    const parent = this.session.get(parentId);
    const held = this.session.db
      .prepare(
        "SELECT detail FROM events WHERE task=? AND kind='gate_held' AND json_extract(detail,'$.attempt')=?",
      )
      .get(parentId, command.expectedAttempt);
    if (
      parent.status !== "blocked" ||
      parent.attempt !== command.expectedAttempt ||
      !held ||
      JSON.parse(String(held.detail)).gate.evaluationId !== command.evaluationId
    )
      throw new DomainError(
        "conflict",
        "Successor requires the current held attempt and gate evaluation.",
      );
    if (taskInput(command.input).project !== parent.project)
      throw new DomainError(
        "forbidden",
        "Successor project must match its parent.",
      );
    if (
      this.session.db
        .prepare(
          "SELECT child FROM task_successors WHERE parent=? AND attempt=? AND evaluation=?",
        )
        .get(parentId, command.expectedAttempt, command.evaluationId)
    )
      throw new DomainError(
        "conflict",
        "This held evaluation already has a successor.",
      );
    return undefined;
  }
  submitSuccessor(
    parentId: string,
    value: SuccessorCommand,
    manifest?: ContextManifest,
  ): SuccessorReceipt {
    const command = successorCommand(value),
      data = taskInput(command.input);
    return this.session.transaction(() => {
      const existing = this.successorSubmission(parentId, command);
      if (existing) return existing;
      const key = "successor:" + hash(parentId + ":" + command.operationId);
      const task = manifest
        ? this.insertResolved(data, key, manifest)
        : this.insertSubmission(data, key);
      this.session.db
        .prepare(
          "INSERT INTO task_successors(parent,attempt,evaluation,operation_id,digest,child) VALUES(?,?,?,?,?,?)",
        )
        .run(
          parentId,
          command.expectedAttempt,
          command.evaluationId,
          command.operationId,
          hash(canonicalValue(command)),
          task.id,
        );
      this.session.event(parentId, "successor_created", {
        taskId: task.id,
        attempt: command.expectedAttempt,
        evaluationId: command.evaluationId,
      });
      this.session.event(task.id, "predecessor_linked", {
        taskId: parentId,
        attempt: command.expectedAttempt,
        evaluationId: command.evaluationId,
      });
      return { task, parentTaskId: parentId, duplicate: false };
    });
  }
  context(id: string): ContextManifest {
    const record = this.session.db
      .prepare("SELECT payload FROM task_contexts WHERE task=?")
      .get(id);
    if (!record)
      throw new DomainError("not_found", "Pinned task context not found");
    return JSON.parse(String(record.payload));
  }
  workerContext(
    w: WorkerRecord,
    id: string,
    lease: string,
    attempt: number,
  ): ContextManifest {
    const assigned = this.session.db
      .prepare(
        "SELECT t.payload FROM attempts a JOIN tasks t ON t.id=a.task WHERE a.task=? AND a.attempt=? AND a.worker=? AND a.lease=?",
      )
      .get(id, attempt, w.id, lease);
    if (
      !assigned ||
      JSON.parse(String(assigned.payload)).project !== w.project
    ) {
      throw new DomainError(
        "forbidden",
        "Context does not belong to this worker assignment",
      );
    }
    // Historical attempt authority permits recovery reads only, never heartbeat or completion.
    return this.context(id);
  }
}
