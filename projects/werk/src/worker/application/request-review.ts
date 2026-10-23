import { unknownProviderOutcome } from './provider-outcome.js';
import { advisoryResult, reviewMessage } from './request-review-protocol.js';
import { DomainError } from "../../shared/errors.js";
import { DEFAULT_MAX_RUNTIME_MS } from "./execution-policy.js";
import type { ConversationModel } from "./conversation.js";
import {
  executeModel,
  modelCapabilities,
  prepareModelRequest,
  ProviderModelError,
  type ModelProvider,
  type ModelRequest,
} from "./model-contract.js";
import {
  unknownUsage,
  type ProviderUsage,
  type RunEvidence,
  type RunOutcome,
} from "./run-evidence.js";
import type { SerialExecutor } from "./serial-executor.js";
import type {
  GateReviewIntent,
  WorkerRequest,
} from "./request-gates.js";
export type AdvisoryResult = NonNullable<GateReviewIntent["result"]>;
export interface RequestReviewPort {
  get(id: string): WorkerRequest;
  queuedReviews(limit?: number): GateReviewIntent[];
  startReview(
    requestId: string,
    intentId: string,
    runId: string,
    dispatch: ModelRequest,
  ): GateReviewIntent;
  observeReviewUsage(
    requestId: string,
    intentId: string,
    usage: ProviderUsage,
  ): void;
  completeReview(
    requestId: string,
    intentId: string,
    result: AdvisoryResult,
    usage: ProviderUsage,
  ): WorkerRequest;
  failReview(
    requestId: string,
    intentId: string,
    code: string,
    usage?: ProviderUsage,
  ): WorkerRequest;
}
export interface RequestReviewOptions {
  gates: RequestReviewPort;
  executor: SerialExecutor;
  runs: RunEvidence;
  model: (
    provider: ModelProvider,
    request: WorkerRequest,
  ) => ConversationModel | undefined;
  maxRuntimeMs?: () => number;
  onReady?: (requestId: string) => Promise<void>;
}
/** One queued advisory intent uses the same worker permit and accounting as ordinary work. */
export class RequestReviewManager {
  private readonly options: RequestReviewOptions;
  private pending?: {
    intent: GateReviewIntent;
    sessionId: string;
    controller: AbortController;
    promise: Promise<void>;
  };
  private closed = false;
  private persistenceError = false;
  private dispatchError: string | null = null;
  constructor(options: RequestReviewOptions) {
    this.options = options;
  }
  snapshot() {
    return {
      active: this.pending?.intent.id ?? null,
      requestId: this.pending?.intent.requestId ?? null,
      persistenceError: this.persistenceError,
      dispatchError: this.dispatchError,
    };
  }
  tick(): void {
    if (this.closed || this.pending || this.persistenceError) return;
    let intent: GateReviewIntent | undefined;
    let sessionId: string | undefined;
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
    this.pending = { intent, sessionId: sessionId!, controller, promise };
  }
  cancel(requestId: string): void {
    if (this.pending?.intent.requestId === requestId)
      this.pending.controller.abort();
  }
  async cancelSessionAndDrain(sessionId: string): Promise<void> {
    const pending = this.pending;
    if (pending?.sessionId === sessionId) {
      pending.controller.abort();
      await pending.promise;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.pending?.controller.abort();
    await this.pending?.promise;
  }
  private current(intent: GateReviewIntent): WorkerRequest {
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
  private async execute(
    intent: GateReviewIntent,
    controller: AbortController,
  ): Promise<void> {
    let runId: string | undefined,
      release: (() => void) | undefined,
      signal = controller.signal;
    let readyRequestId: string | undefined;
    let usage = unknownUsage(),
      knownResult = false, retainPermit = false,
      outcome: Exclude<RunOutcome, "queued" | "running"> = "failed";
    try {
      const request = this.current(intent),
        model = this.options.model(intent.provider, request);
      if (!model) throw new ProviderModelError("unavailable");
      const frozen = {
        reply: model.reply.bind(model),
        configuration: structuredClone(intent.provider),
        ...(intent.provider.id === 'cursor-cli' ? { capabilities: { ...modelCapabilities, tools: 'provider_native' } } : {}),
      } as ConversationModel;
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
          ...(dispatch.provider.authenticationMode ? { authenticationMode: dispatch.provider.authenticationMode } : {}),
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
          this.options.runs.observeUsage?.(runId!, value);
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
      const completed = this.options.gates.completeReview(request.id, intent.id, parsed, usage);
      if (parsed.readiness && completed.phase === 'ready') readyRequestId = completed.id;
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
        const unknown = unknownProviderOutcome(error);
        if (unknown && runId) {
          try { this.options.runs.reserveUnknown(runId, unknown); }
          catch { retainPermit = true; this.persistenceError = true; }
        }
        outcome = unknown ? "failed" : controller.signal.aborted ? "interrupted" : "failed";
        const code = unknown ?? (controller.signal.aborted
          ? "interrupted"
          : signal.aborted
            ? "timeout"
            : error instanceof ProviderModelError
              ? error.code
              : error instanceof DomainError
                ? error.code === "conflict"
                  ? "superseded"
                  : error.code
                : "execution_failed");
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
    if (runId && !retainPermit) {
      try {
        await this.options.runs.finish(runId, outcome, usage);
      } catch {
        this.persistenceError = true;
      }
    }
    if (!retainPermit) release?.();
    if (readyRequestId && this.options.onReady && !controller.signal.aborted) {
      try { await this.options.onReady(readyRequestId); this.dispatchError = null; }
      catch { this.dispatchError = 'The readiness assessment is saved, but dispatch did not finish. Inspect the request and explicitly Execute its ready revision; the reviewer will not be replayed.'; }
    }
  }
}
