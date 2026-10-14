import type {
  RequestCommand,
  RequestSummary,
  WorkerRequest,
} from "../application/request-gates.js";
export type GateActionCommand =
  | RequestCommand
  | {
      action: "execute";
      requestId: string;
      expectedRevision: number;
      operationId: string;
    };
export type GateCommandFields =
  | Omit<RequestCommand, "requestId" | "expectedRevision" | "operationId">
  | { action: "execute" };
export interface GateControllerState {
  view: WorkerRequest | null;
  rows: RequestSummary[];
  selected: string;
  loading: boolean;
  busy: boolean;
  error: string;
  notice: string;
}
export interface GateControllerContext {
  sessionId: string;
  requestId?: string;
  unlocked: boolean;
}
export interface GateDispatchReceipt {
  inputRevision: number;
  state: "not_requested" | "not_admitted" | "admitted";
  note: string;
}
export interface GateMutationResult {
  request: WorkerRequest;
  duplicate: boolean;
  dispatch?: GateDispatchReceipt;
}
interface Dependencies {
  state: GateControllerState;
  current(): GateControllerContext;
  api(command: Record<string, unknown> | GateActionCommand): Promise<unknown>;
  operations: Map<string, GateActionCommand>;
  operationId(): string;
  changed(view: WorkerRequest | null): void;
  refresh(): Promise<void>;
}
export const initialGateState = (): GateControllerState => ({
  view: null,
  rows: [],
  selected: "",
  loading: false,
  busy: false,
  error: "",
  notice: "",
});
/** Coordinates reads and retry-safe intent; the API remains the lifecycle authority. */
export class RequestGateController {
  private generation = 0;
  private disposed = false;
  private dependencies: Dependencies;
  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
  }
  get identity() {
    return (
      this.dependencies.current().requestId || this.dependencies.state.selected
    );
  }
  private valid(generation: number, sessionId: string) {
    const current = this.dependencies.current();
    return (
      !this.disposed &&
      generation === this.generation &&
      current.unlocked &&
      current.sessionId === sessionId
    );
  }
  invalidate(resetSelection = true) {
    this.generation++;
    const state = this.dependencies.state;
    Object.assign(state, {
      view: null,
      rows: [],
      loading: false,
      busy: false,
      error: "",
      notice: "",
    });
    if (resetSelection)
      state.selected = this.dependencies.current().requestId ?? "";
  }
  dispose() {
    this.disposed = true;
    this.generation++;
  }
  async select(id: string) {
    this.dependencies.state.selected = id;
    this.invalidate(false);
    await this.load(true);
  }
  async load(force = false) {
    const { state } = this.dependencies,
      context = this.dependencies.current();
    if (
      this.disposed ||
      !context.unlocked ||
      !context.sessionId ||
      state.loading ||
      state.busy
    )
      return;
    const generation = ++this.generation,
      owner = context.sessionId;
    state.loading = true;
    try {
      const list = (await this.dependencies.api({
        action: "list",
        sessionId: owner,
        limit: 100,
      })) as {
        schemaVersion: 1;
        rows: RequestSummary[];
        total: number;
        nextOffset: number | null;
      };
      if (!this.valid(generation, owner)) return;
      state.rows = list.rows;
      if (
        !this.dependencies.current().requestId &&
        !list.rows.some((row) => row.id === state.selected)
      )
        state.selected = list.rows[0]?.id ?? "";
      const id = this.identity;
      if (!id) {
        state.view = null;
        state.error = "";
        this.dependencies.changed(null);
        return;
      }
      const summary = list.rows.find((row) => row.id === id);
      if (
        !force &&
        state.view?.id === id &&
        (!summary || summary.revision === state.view.revision)
      ) {
        state.error = "";
        return;
      }
      const result = (await this.dependencies.api({
        action: "get",
        requestId: id,
      })) as WorkerRequest;
      if (!this.valid(generation, owner) || id !== this.identity) return;
      state.view = result;
      state.error = "";
      this.dependencies.changed(result);
    } catch (failure) {
      if (this.valid(generation, owner))
        state.error = (failure as Error).message;
    } finally {
      if (generation === this.generation && !this.disposed)
        state.loading = false;
    }
  }
  async mutate(fields: GateCommandFields) {
    const { state, operations } = this.dependencies;
    if (
      !state.view ||
      !this.dependencies.current().unlocked ||
      state.busy ||
      state.loading ||
      operations.has(state.view.id)
    )
      return;
    const command = {
      ...fields,
      requestId: state.view.id,
      expectedRevision: state.view.revision,
      operationId: this.dependencies.operationId(),
    } as GateActionCommand;
    operations.set(command.requestId, command);
    await this.send(command);
  }
  async send(command: GateActionCommand) {
    const { state, operations } = this.dependencies,
      context = this.dependencies.current();
    if (this.disposed || !context.unlocked || state.busy) return;
    const generation = this.generation;
    state.busy = true;
    state.error = "";
    state.notice = "";
    try {
      const result = (await this.dependencies.api(
        command,
      )) as GateMutationResult;
      if (
        operations.get(command.requestId)?.operationId === command.operationId
      )
        operations.delete(command.requestId);
      if (
        !this.valid(generation, context.sessionId) ||
        command.requestId !== this.identity
      )
        return;
      state.view = result.request;
      this.dependencies.changed(result.request);
      state.notice =
        result.dispatch?.state === "not_admitted"
          ? result.dispatch.note
          : result.duplicate
            ? "The earlier operation was already recorded. No duplicate work was admitted."
            : (result.dispatch?.state === "admitted" ? result.dispatch.note : undefined) ||
              "Request updated. Its current phase and evidence are shown below.";
      await this.dependencies.refresh();
    } catch (failure) {
      const status = (failure as Error & { status?: number }).status;
      if (
        status &&
        status >= 400 &&
        status < 500 &&
        status !== 401 &&
        operations.get(command.requestId)?.operationId === command.operationId
      )
        operations.delete(command.requestId);
      if (this.valid(generation, context.sessionId))
        state.error = (failure as Error).message;
    } finally {
      if (generation === this.generation && !this.disposed) state.busy = false;
    }
  }
}
