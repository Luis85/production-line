import type { StoreState, StoreRuntime } from './store-state';
import type { Factory, ProductionLine, LineOverview } from '../../shared/factory.js';
import type { IntakeRecord, Intent } from './store-contracts';
import type { ComputedRef } from 'vue';

export interface StoreContext {
  state: StoreState;
  runtime: StoreRuntime;
  fetcher: typeof fetch;
}

export interface StoreOperations {
  current(own: number): boolean;
  api<T = any>(path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal; token?: string; key?: string; }): Promise<T>;
  key(intent: Intent, method: string, path: string, body?: unknown): string;
  adoptRegistry(result: any): void;
  connect(token: string): Promise<void>;
  disconnect(preserveDrafts?: boolean): void;
  reconcileFactory(): void;
  refresh(registry?: boolean): Promise<void>;
  navigate(scope: string, lineId?: string): void;
  descendants(id?: string): Set<string>;
  factoryPath(id: string): string;
  selectedLines: ComputedRef<ProductionLine[]>;
  selectedFactory: ComputedRef<Factory | undefined>;
  observations: ComputedRef<Map<string, LineOverview>>;
  activeLine: ComputedRef<ProductionLine | undefined>;
  activeObservation: ComputedRef<LineOverview | undefined>;
  managed(type: "factory" | "line", id?: string | null): boolean;
  mayEdit(type: "factory" | "line", id?: string | null): boolean;
  nextStep: ComputedRef<string>;
  openEditor(type: "factory" | "line", record?: Factory | ProductionLine): void;
  saveEditor(): Promise<void>;
  confirmRemoval(type: "factory" | "line", record: Factory | ProductionLine): void;
  removeConfirmed(): Promise<void>;
  editPolicy(): void;
  loadPolicy(): Promise<void>;
  savePolicy(): Promise<void>;
  loadQueue(): Promise<void>;
  submitIntake(): Promise<void>;
  assignTarget(item: IntakeRecord): Promise<void>;
}
