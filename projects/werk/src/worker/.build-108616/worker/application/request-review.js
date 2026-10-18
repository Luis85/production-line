import { DomainError } from "../../shared/errors.js";
import { DEFAULT_MAX_RUNTIME_MS } from "./execution-policy.js";
                                                                        
import {
  executeModel,
  prepareModelRequest,
  ProviderModelError,
  parseModelResult,
                     
                    
                   
} from "./model-contract.js";
import {
  unknownUsage,
                     
                   
                  
} from "./run-evidence.js";
                                                           
             
            
                   
            
                
                            
                                                                     
                                    
                                 
                                                    
              
                      
                     
                  
                           
                      
                     
                      
                     
                         
          
                 
                      
                     
                           
                         
                   
             
                      
                     
                 
                          
                   
 
                                       
                           
                           
                    
          
                            
                           
                                     
                              
 
const object = (value         )                                   =>
  !!value && typeof value === "object" && !Array.isArray(value);
const boundedText = (value         , limit        )                  =>
  typeof value === "string" && !!value.trim() && value.length <= limit;
const protocol = ()        => {
  throw new ProviderModelError("protocol");
};
/** Model output is advisory text only: no facts, policy, authority or approved-file changes. */
export function parseAdvisoryReview(
  text        ,
  input           ,
  stage           ,
  kind                      = "review",
)                 {
  if (typeof text !== "string" || Buffer.byteLength(text) > 262144) protocol();
  let value         ;
  try {
    value = JSON.parse(text);
  } catch {
    return protocol();
  }
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) => !["schemaVersion", "findings", "candidate"].includes(key),
    ) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.findings) ||
    value.findings.length > 32
  )
    return protocol();
  const findings = value.findings.map((raw) => {
    if (
      !object(raw) ||
      Object.keys(raw).some(
        (key) => !["kind", "message", "blocking"].includes(key),
      ) ||
      !["question", "issue", "gap"].includes(String(raw.kind)) ||
      !boundedText(raw.message, 4000) ||
      typeof raw.blocking !== "boolean"
    )
      return protocol();
    return {
      kind: raw.kind                                ,
      message: raw.message,
      blocking: raw.blocking,
    };
  });
  let candidate                       ;
  if (value.candidate !== undefined) {
    if (
      !object(value.candidate) ||
      Object.keys(value.candidate).some((key) => key !== "message") ||
      !boundedText(value.candidate.message, 8000)
    )
      return protocol();
    candidate = { ...structuredClone(input), message: value.candidate.message };
  }
  return {
    summary:
      kind === "rework"
        ? "Advisory rework candidate."
        : stage === "ready"
          ? "Advisory readiness review."
          : "Advisory completion review.",
    findings,
    ...(candidate ? { candidate } : {}),
  };
}
function advisoryResult(
  result             ,
  input           ,
  stage           ,
  kind                     ,
)                 {
  if (result.type === "completed")
    return parseAdvisoryReview(result.text, input, stage, kind);
  // A typed blocking question is the other defined model protocol, never arbitrary prose.
  const validated = parseModelResult(
    JSON.stringify({ werkInteraction: result.request }),
  );
  if (
    validated.type !== "needs_input" ||
    !boundedText(validated.request.message, 4000)
  )
    return protocol();
  return {
    summary: "Advisory review needs an operator decision.",
    findings: [
      {
        kind: validated.request.kind === "question" ? "question" : "issue",
        message: validated.request.message,
        blocking: true,
      },
    ],
  };
}
function reviewMessage(
  request               ,
  intent                  ,
)              {
  const evaluation = request.evaluations.find(
    (item) => item.id === intent.evaluationId,
  );
  const payload = {
    requestId: request.id,
    stage: intent.stage,
    intent: intent.kind,
    inputRevision: request.inputRevision,
    inputHash: intent.inputHash,
    policyDigest: intent.policyDigest,
    input: request.input,
    rules: evaluation?.rules ?? [],
    findings: request.findings.filter((item) => item.status === "open"),
    output:
      intent.stage === "done" ? (request.execution?.result ?? null) : null,
  };
  const data = JSON.stringify(payload);
  if (Buffer.byteLength(data) > 262144)
    throw new DomainError("too_large", "Advisory context exceeds its bound.");
  const instruction =
    'Review only the supplied request and deterministic gate observations. You have no tools, commands or live environment access. Never claim tests, builds, operator acceptance or policy facts. Do not change policy, kind, approved paths, criteria or context. Findings are advisory; only deterministic evaluation and explicit operator decisions authorize execution. Return ONLY JSON {"schemaVersion":1,"findings":[{"kind":"question|issue|gap","message":"bounded actionable observation","blocking":true}],"candidate":{"message":"optional revised request text"}}. Maximum 32 findings; each message at most 4000 characters; candidate.message at most 8000 characters. No other fields. An empty findings array is valid. ' +
    (intent.kind === "rework"
      ? "This is an explicit rework request: propose revised text without inventing answers to unresolved questions."
      : "You may propose improved text but must not treat it as accepted input.");
  return {
    id: intent.id,
    role: "user",
    state: "complete",
    at: intent.createdAt,
    text: instruction + "\nRequest data:\n" + data,
  };
}
/** One queued advisory intent uses the same worker permit and accounting as ordinary work. */
export class RequestReviewManager {
                   options                      ;
          pending    
                             
                      
                                
                           
   ;
          closed = false;
          persistenceError = false;
  constructor(options                      ) {
    this.options = options;
  }
  snapshot() {
    return {
      active: this.pending?.intent.id ?? null,
      requestId: this.pending?.intent.requestId ?? null,
      persistenceError: this.persistenceError,
    };
  }
  tick()       {
    if (this.closed || this.pending || this.persistenceError) return;
    let intent                              ;
    let sessionId                    ;
    try {
      intent = this.options.gates.queuedReviews(1)[0];
      if (intent)
        sessionId = this.options.gates.get(intent.requestId).owner.sessionId;
    } catch {
      this.persistenceError = true;
      return;
    }
    if (!intent) return;
    const controller = new AbortController();
    const promise = this.execute(intent, controller).finally(() => {
      this.pending = undefined;
    });
    this.pending = { intent, sessionId: sessionId , controller, promise };
  }
  cancel(requestId        )       {
    if (this.pending?.intent.requestId === requestId)
      this.pending.controller.abort();
  }
  async cancelSessionAndDrain(sessionId        )                {
    const pending = this.pending;
    if (pending?.sessionId === sessionId) {
      pending.controller.abort();
      await pending.promise;
    }
  }
  async close()                {
    this.closed = true;
    this.pending?.controller.abort();
    await this.pending?.promise;
  }
          current(intent                  )                {
    const request = this.options.gates.get(intent.requestId);
    const retained = request.reviews.find((item) => item.id === intent.id);
    const latest = request.evaluations
      .filter((item) => item.stage === intent.stage)
      .at(-1);
    if (
      latest?.passed ||
      !retained ||
      retained.status !== "queued" ||
      request.inputHash !== intent.inputHash ||
      request.policyDigest !== intent.policyDigest ||
      request.phase === "cancelled"
    )
      throw new DomainError("conflict", "This advisory intent was superseded.");
    return request;
  }
          async execute(
    intent                  ,
    controller                 ,
  )                {
    let runId                    ,
      release                          ,
      signal = controller.signal;
    let usage = unknownUsage(),
      knownResult = false,
      outcome                                            = "failed";
    try {
      const request = this.current(intent),
        model = this.options.model(intent.provider, request);
      if (!model) throw new ProviderModelError("unavailable");
      const frozen = {
        reply: model.reply.bind(model),
        configuration: structuredClone(intent.provider),
      }                     ;
      const dispatch = prepareModelRequest(
        frozen,
        [reviewMessage(request, intent)],
        "chat",
        this.options.maxRuntimeMs?.() ?? DEFAULT_MAX_RUNTIME_MS,
      );
      runId = (
        await this.options.runs.begin({
          sessionId: request.owner.sessionId,
          taskId: request.owner.taskId ?? request.id,
          kind: request.input.kind === "patch" ? "local" : "chat",
          purpose: intent.kind === "rework" ? "rework" : "gate_review",
          requestId: request.id,
          title:
            (intent.kind === "rework" ? "Rework: " : "Advisory review: ") +
            request.input.title,
          provider: dispatch.provider.id,
          model: dispatch.provider.model,
        })
      ).id;
      release = await this.options.executor.acquire(
        request.owner.sessionId,
        controller.signal,
      );
      this.current(intent); // Waiting for the shared permit must not resurrect an obsolete generation.
      signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(
          dispatch.policy.maxRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS,
        ),
      ]);
      this.options.gates.startReview(request.id, intent.id, runId, dispatch);
      await this.options.runs.start(runId);
      signal.throwIfAborted();
      const result = await executeModel(model, dispatch, signal, (value) => {
        usage = value;
        try {
          this.options.runs.observeUsage?.(runId , value);
          this.options.gates.observeReviewUsage(request.id, intent.id, value);
        } catch {
          this.persistenceError = true;
        }
      });
      signal.throwIfAborted();
      const parsed = advisoryResult(
        result,
        request.input,
        intent.stage,
        intent.kind,
      );
      this.options.gates.completeReview(request.id, intent.id, parsed, usage);
      knownResult = true;
      outcome = "completed";
    } catch (error) {
      // A committed result cannot be relabelled or paid for again if a later projection failed.
      try {
        knownResult = !!this.options.gates
          .get(intent.requestId)
          .reviews.find((item) => item.id === intent.id)?.result;
      } catch {
        this.persistenceError = true;
      }
      if (knownResult) outcome = "completed";
      else {
        outcome = controller.signal.aborted ? "interrupted" : "failed";
        const code = controller.signal.aborted
          ? "interrupted"
          : signal.aborted
            ? "timeout"
            : error instanceof ProviderModelError
              ? error.code
              : error instanceof DomainError
                ? error.code === "conflict"
                  ? "superseded"
                  : error.code
                : "execution_failed";
        try {
          this.options.gates.failReview(
            intent.requestId,
            intent.id,
            code,
            usage,
          );
        } catch {
          this.persistenceError = true;
        }
      }
    }
    if (runId) {
      try {
        await this.options.runs.finish(runId, outcome, usage);
      } catch {
        this.persistenceError = true;
      }
    }
    release?.();
  }
}
