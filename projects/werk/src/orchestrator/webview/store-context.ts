import type { StoreState, StoreRuntime } from './store-state';
import type { Tab, RecordData, Page, StoreOptions } from './store-contracts';

export interface StoreContext {
  state: StoreState;
  runtime: StoreRuntime;
  now: () => number;
  uuid: () => string;
  request: NonNullable<StoreOptions['request']>;
}

export interface StoreOperations {
  message(text: string, kind?: string): void;
  api(
    path: string,
    body?: RecordData,
    method?: string,
    signal?: AbortSignal,
    key?: string,
    credential?: string,
  ): Promise<any>;
  applyAccess(access: any): void;
  clearSession(expired?: boolean): void;
  expire(error: any, own: number): boolean;
  connect(candidate: string): Promise<void>;
  disconnect(): void;
  pageUrl(path: string, page: Page, limit?: number): string;
  refresh(options?: { reset?: boolean; page?: Page }): Promise<void>;
  navigate(tab: Tab): Promise<void>;
  movePage(kind: "tasks" | "workers", direction: "next" | "previous"): Promise<boolean>;
  inspectSnapshots(taskId: string): Promise<void>;
  poll(): Promise<void>;
  closeTask(): void;
  closeWorker(): void;
  loadEvents(direction?: "next" | "previous"): Promise<void>;
  showTask(task: RecordData): Promise<void>;
  showTaskId(id: string): Promise<void>;
  showWorker(id: string): Promise<void>;
  intakePayload(): RecordData;
  submitTask(): Promise<any>;
  checkReadiness(): Promise<void>;
  loadRouting(): Promise<void>;
  saveRouting(): Promise<void>;
  saveTaskRouting(): Promise<void>;
}
