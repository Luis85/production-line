import { object, identifier, taskInput } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";
import type { Task } from "../../shared/contracts.js";

export interface SuccessorCommand {
  expectedAttempt: number;
  evaluationId: string;
  operationId: string;
  input: unknown;
}
export interface SuccessorReceipt {
  task: Task;
  parentTaskId: string;
  duplicate: boolean;
}
export function successorCommand(value: unknown): SuccessorCommand {
  const body = object(value, "Successor command", [
    "expectedAttempt",
    "evaluationId",
    "operationId",
    "input",
  ]);
  if (
    !Number.isSafeInteger(body.expectedAttempt) ||
    Number(body.expectedAttempt) < 1
  )
    throw new DomainError(
      "invalid_input",
      "expectedAttempt must be a positive safe integer.",
    );
  const evaluationId = identifier(body.evaluationId, "evaluationId");
  if (
    typeof body.operationId !== "string" ||
    !/^[\w:.-]{1,100}$/.test(body.operationId)
  )
    throw new DomainError(
      "invalid_input",
      "operationId requires 1–100 letters, digits, _, :, . or -.",
    );
  return {
    expectedAttempt: body.expectedAttempt as number,
    evaluationId,
    operationId: body.operationId,
    input: taskInput(body.input),
  };
}
/** Stable payload identity is independent of JSON member order. */
export function canonicalValue(value: unknown): string {
  if (Array.isArray(value))
    return "[" + value.map(canonicalValue).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonicalValue((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
