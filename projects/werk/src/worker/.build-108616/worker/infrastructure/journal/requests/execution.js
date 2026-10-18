             
             
                                                
import {
  gateDigest,
  validateGateFacts,
                       
} from "../../../application/request-gates.js";
import { requestAssertReady, requestEvaluateInside } from './gates.js';
                                               
import { clone, conflict, identifier, invalid } from './values.js';

export function requestPrepareExecution(store              , id        , turnId        , runId        ) {
  identifier(turnId, "turn ID");
  identifier(runId, "run ID");
  return store.transaction(() => {
    const request = store.get(id);
    requestAssertReady(request);
    const bound = store.database()
      .prepare(
        "SELECT request_id,input_revision FROM request_turns WHERE session_id=? AND turn_id=?",
      )
      .get(request.owner.sessionId, turnId);
    if (
      bound?.request_id !== id ||
      Number(bound.input_revision) !== request.inputRevision
    )
      conflict("Bind the turn to this request generation before execution.");
    if (request.execution?.turnId === turnId) {
      if (request.execution.runId !== runId)
        conflict("The execution run is immutable.");
      return request;
    }
    if (
      request.execution &&
      ["prepared", "running"].includes(request.execution.status)
    )
      conflict("This request already has an admitted execution.");
    request.execution = {
      turnId,
      runId,
      inputRevision: request.inputRevision,
      status: "prepared",
      outcome: null,
      result: null,
      outputDigest: null,
      facts: {},
    };
    store.save(request, "execution_prepared", { turnId, runId });
    return request;
  });
}

export function requestStartExecution(store              , id        , turnId        , runId        ) {
  return store.transaction(() => {
    const request = store.get(id);
    requestAssertReady(request);
    const execution = request.execution;
    if (
      !execution ||
      execution.turnId !== turnId ||
      execution.runId !== runId ||
      execution.inputRevision !== request.inputRevision ||
      !["prepared", "running"].includes(execution.status)
    )
      conflict("Execution does not match its durable intent.");
    if (execution.status === "running") return request;
    execution.status = "running";
    request.phase = "running";
    store.save(request, "execution_started", { turnId, runId });
    return request;
  });
}

export function requestRecordResult(
  store              ,
  id        ,
  turnId        ,
  runId        ,
  result             ,
  facts                   = {},
) {
  if (
    !result ||
    !["completed", "needs_input"].includes(result.type) ||
    (result.type === "completed" &&
      (typeof result.text !== "string" || result.text.length > 1048576)) ||
    (result.type === "needs_input" &&
      (!result.request ||
        !["question", "escalation"].includes(result.request.kind) ||
        typeof result.request.message !== "string"))
  )
    invalid("Invalid known execution result.");
  const acceptedFacts = validateGateFacts(facts);
  if (Object.keys(acceptedFacts).some((key) => !key.startsWith("output.")))
    invalid(
      "Execution can only supply output facts; approvals and test claims require independent evidence.",
    );
  return store.transaction(() => {
    const request = store.get(id),
      execution = request.execution;
    if (
      !execution ||
      execution.turnId !== turnId ||
      execution.runId !== runId ||
      execution.inputRevision !== request.inputRevision
    )
      conflict("Known result does not match the current execution intent.");
    const outputDigest = gateDigest({ result, facts: acceptedFacts });
    if (execution.result) {
      if (execution.outputDigest !== outputDigest)
        conflict("A known execution result is immutable.");
      return request;
    }
    execution.result = clone(result);
    execution.outputDigest = outputDigest;
    execution.status = "completed";
    execution.outcome =
      result.type === "completed"
        ? request.input.kind === "patch"
          ? "review"
          : "completed"
        : result.request.kind === "question"
          ? "waiting_input"
          : "escalated";
    execution.facts = {
      ...acceptedFacts,
      "output.nonEmpty": result.type === "completed" && !!result.text.trim(),
      "output.protocolValid":
        result.type === "completed" &&
        (request.input.kind === "chat" ||
          acceptedFacts["output.protocolValid"] === true),
    };
    if (result.type === "needs_input") {
      request.phase =
        result.request.kind === "question" ? "waiting_input" : "escalated";
      store.save(request, "input_requested", { turnId, runId });
    } else {
      store.save(request, "result_recorded", { turnId, runId });
      requestEvaluateInside(store, request, "done");
    }
    return request;
  });
}

export function requestFailExecution(
  store              ,
  id        ,
  turnId        ,
  status                                        ,
) {
  if (!["failed", "cancelled", "interrupted"].includes(status))
    invalid("Invalid execution failure state.");
  return store.transaction(() => {
    const request = store.get(id),
      execution = request.execution;
    if (!execution || execution.turnId !== turnId)
      conflict("Execution failure does not match this request.");
    if (execution.result || execution.status === status) return request;
    execution.status = status;
    execution.outcome = status;
    request.phase = status;
    store.save(request, "execution_" + status, {
      turnId,
      runId: execution.runId,
    });
    return request;
  });
}
