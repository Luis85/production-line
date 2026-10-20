import type { DeliveryStopObservation, DeliveryUpdate } from '../../application/delivery-contracts.js';
import { requestDeliveryUpdate, requestReviseInput } from './requests/delivery.js';
import type { FeatureIdentityJournal } from '../../application/journal-ports.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelResult,
} from "../../application/model-contract.js";
import {
  type GateFactSnapshot,
  type GateInput,
  type GateReviewIntent,
  type GateStage,
  type RequestCommand,
  type RequestGatePort,
  type RequestOwner,
  type WorkerRequest
} from "../../application/request-gates.js";
import type { ProviderUsage } from "../../application/run-evidence.js";
import { requestBindFeature, requestBindTurn, requestEnsure } from './requests/admission.js';
import { requestCommand, requestPolicy, requestReplayCommand, requestSetPolicy } from './requests/commands.js';
import { requestFailExecution, requestPrepareExecution, requestRecordResult, requestStartExecution } from './requests/execution.js';
import { requestEvaluate, requestHoldRecovery } from './requests/gates.js';
import { requestEvents, requestExecution, requestForSession, requestForTurn, requestHasActiveReview, requestUnresolvedExecutions, requestList } from './requests/queries.js';
import { requestCompleteReview, requestFailReview, requestObserveReviewUsage, requestQueuedReviews, requestReserveReview, requestStartReview } from './requests/reviews.js';
import { RequestStore } from './requests/store.js';

/** Authoritative request state. The store alone owns its SQLite connection and transactions. */
export class WorkerRequestJournal implements RequestGatePort, FeatureIdentityJournal {
  private readonly store: RequestStore;
  constructor(directory: string) {
    this.store = new RequestStore(directory);
  }
  async init() {
    return this.store.init();
  }
  async open() { return this.store.open(); }
  recover(retained: ReadonlySet<string> = new Set()) { return this.store.recover(retained); }
  preparedForRecovery(id: string) { return this.store.preparedForRecovery(id); }
  close() {
    return this.store.close();
  }
  bindFeature(sessionId: string, featureId: string): void {
    requestBindFeature(this.store, sessionId, featureId);
  }
  deliveryUpdate(id: string, update: DeliveryUpdate): WorkerRequest { return requestDeliveryUpdate(this.store, id, update); }
  reviseInput(id: string, input: GateInput): WorkerRequest { return requestReviseInput(this.store, id, input); }
  unresolvedExecutions() { return requestUnresolvedExecutions(this.store); }
  get(id: string): WorkerRequest {
    return this.store.get(id);
  }
  execution(id: string, turnId: string) {
    return requestExecution(this.store, id, turnId);
  }
  hasActiveReview(sessionId: string): boolean {
    return requestHasActiveReview(this.store, sessionId);
  }
  forSession(sessionId: string): WorkerRequest | undefined {
    return requestForSession(this.store, sessionId);
  }
  forTurn(sessionId: string, turnId: string): WorkerRequest | undefined {
    return requestForTurn(this.store, sessionId, turnId);
  }
  list(
    options: {
      sessionId?: string;
      phase?: string;
      limit?: number;
      after?: number;
      offset?: number;
    } = {},
  ) {
    return requestList(this.store, options);
  }
  events(id: string, after = 0, limit = 100) {
    return requestEvents(this.store, id, after, limit);
  }
  ensure(input: {
    owner: RequestOwner;
    input: GateInput;
    provider: ModelProvider;
    policy?: WorkerRequest["policy"];
  }): WorkerRequest {
    return requestEnsure(this.store, input);
  }
  bindTurn(id: string, turnId: string, inputRevision?: number, answeredTurnId?: string) {
    return requestBindTurn(this.store, id, turnId, inputRevision, answeredTurnId);
  }
  evaluate(id: string, stage: GateStage) {
    return requestEvaluate(this.store, id, stage);
  }
  holdRecovery(id: string, reason = "checkpoint_ownership") {
    return requestHoldRecovery(this.store, id, reason);
  }
  prepareExecution(id: string, turnId: string, runId: string) {
    return requestPrepareExecution(this.store, id, turnId, runId);
  }
  startExecution(id: string, turnId: string, runId: string) {
    return requestStartExecution(this.store, id, turnId, runId);
  }
  recordResult(
    id: string,
    turnId: string,
    runId: string,
    result: ModelResult,
    facts: GateFactSnapshot = {},
  ) {
    return requestRecordResult(this.store, id, turnId, runId, result, facts);
  }
  failExecution(
    id: string,
    turnId: string,
    status: "failed" | "cancelled" | "interrupted",
  ) {
    return requestFailExecution(this.store, id, turnId, status);
  }
  reserveReview(id: string, stage: GateStage): GateReviewIntent {
    return requestReserveReview(this.store, id, stage);
  }
  queuedReviews(limit = 20): GateReviewIntent[] {
    return requestQueuedReviews(this.store, limit);
  }
  startReview(
    id: string,
    intentId: string,
    runId: string,
    dispatch: ModelRequest,
  ): GateReviewIntent {
    return requestStartReview(this.store, id, intentId, runId, dispatch);
  }
  observeReviewUsage(id: string, intentId: string, usage: ProviderUsage) {
    return requestObserveReviewUsage(this.store, id, intentId, usage);
  }
  completeReview(
    id: string,
    intentId: string,
    result: NonNullable<GateReviewIntent["result"]>,
    usage: ProviderUsage,
  ): WorkerRequest {
    return requestCompleteReview(this.store, id, intentId, result, usage);
  }
  failReview(
    id: string,
    intentId: string,
    code: string,
    usage?: ProviderUsage,
  ) {
    return requestFailReview(this.store, id, intentId, code, usage);
  }
  replayCommand(input: RequestCommand) { return requestReplayCommand(this.store, input); }
  command(input: RequestCommand, stopped?: DeliveryStopObservation): {
    request: WorkerRequest;
    duplicate: boolean;
  } {
    return requestCommand(this.store, input, stopped);
  }
  policy() {
    return requestPolicy(this.store);
  }
  setPolicy(input: {
    policy: unknown;
    expectedRevision: number;
    operationId: string;
  }) {
    return requestSetPolicy(this.store, input);
  }
  deleteSession(sessionId: string) {
    return this.store.deleteSession(sessionId);
  }
}
