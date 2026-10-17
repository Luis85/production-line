import type { Tab, RecordData, StoreOptions } from './store-contracts';
import { firstPage } from './store-contracts';

export function createState(reactive: NonNullable<StoreOptions['reactive']> = value => value) {
  return reactive({
    token: "",
    canWrite: false,
    role: "",
    tab: "system" as Tab,
    connecting: false,
    submitting: false,
    busy: false,
    paused: false,
    message: "",
    messageKind: "info",
    sync: "Noch nicht verbunden",
    refreshedAt: null as number | null,
    stale: false,
    overview: null as RecordData | null,
    readinessAt: null as number | null,
    readinessBusy: false,
    readinessError: "",
    tasks: [] as RecordData[],
    workers: [] as RecordData[],
    taskPage: firstPage(),
    workerPage: firstPage(),
    eventPage: firstPage(),
    selectedTask: null as RecordData | null,
    events: [] as RecordData[],
    eventBusy: false,
    eventError: "",
    workerId: "",
    workerDetail: null as RecordData | null,
    workerBusy: false,
    workerError: "",
    taskSearch: "",
    taskStatus: "",
    showEmptyStatuses: false,
    metrics: [] as RecordData[],
    metricsTruncated: false,
    selectedSnapshot: null as RecordData | null,
    metricFilters: {
      project: "",
      worker: "",
      iteration: "",
      outcome: "",
      window: "",
      taskId: "",
    },
    intake: {
      project: "demo",
      repository: "",
      projectEdited: false,
      mode: "vault",
      executionMode: "mock",
      provider: "auto",
      priority: "1",
      title: "",
      criteria: "",
      wikilinks: "",
      requirementRef: "",
    },
    intakeSample: null as {
      count: number;
      imported: number;
      hasMore: boolean;
    } | null,
    routing: {
      mode: "auto",
      workerId: "",
      order: "worker",
      workers: [] as RecordData[],
      busy: false,
      loaded: false,
      message: "",
    },
    taskRouting: { workerId: "", busy: false, message: "" },
    interactionOpen: false,
    tourOpen: false,
  });
}

export function createRuntime() {
  return {
    generation: 0,
    connectId: 0,
    readId: 0,
    detailId: 0,
    workerRead: 0,
    routingRead: 0,
    routeWrite: 0,
    readinessRead: 0,
    readController: null as AbortController | null,
    eventController: null as AbortController | null,
    workerController: null as AbortController | null,
    lastBody: "",
    retryKey: "",
  };
}

export type StoreState = ReturnType<typeof createState>;
export type StoreRuntime = ReturnType<typeof createRuntime>;
