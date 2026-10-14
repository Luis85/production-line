import type { WorkerRequest } from "./request-gates.js";
export interface RequestDispatchStatus {
  scope: "current_input_generation";
  inputRevision: number;
  state: "not_requested" | "not_admitted" | "admitted";
  note: string;
}
/** A durable command receipt acknowledges policy mutation, not an exactly-once cross-journal model dispatch. */
export function requestDispatchStatus(
  request: WorkerRequest,
  action: string,
): RequestDispatchStatus {
  const requested = action === "execute" || action === "accept_candidate";
  const admitted = request.execution?.inputRevision === request.inputRevision;
  return {
    scope: "current_input_generation",
    inputRevision: request.inputRevision,
    state: !requested
      ? "not_requested"
      : admitted
        ? "admitted"
        : "not_admitted",
    note: !requested
      ? "This command did not request primary execution."
      : admitted
        ? "Admission is recorded for this input generation. Inspect its execution status for the outcome."
        : request.phase === "ready"
          ? "No primary admission is recorded for the current input generation. Read the current request and issue a new guarded execute with a new operation ID. Replaying a command receipt never dispatches new work."
          : "No primary admission is recorded for the current input generation. Inspect its gate findings before issuing another guarded execute.",
  };
}
