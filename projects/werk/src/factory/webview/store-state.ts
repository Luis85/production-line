import type { Factory, ProductionLine, FactoryOverview } from '../../shared/factory.js';
import type { Editor, IntakePage, RoutingPolicy, Intent } from './store-contracts';
import { reactive } from 'vue';

export function createState() {
  return reactive({
    token: "",
    scope: "",
    lineId: "",
    factories: [] as Factory[],
    lines: [] as ProductionLine[],
    cache: new Map<string, FactoryOverview>(),
    overview: null as FactoryOverview | null,
    loading: false,
    connecting: false,
    saving: false,
    paused: false,
    canWrite: false,
    role: "",
    managed: { factories: [] as string[], lines: [] as string[] },
    message: "Verbinde dich, um Fabriken und Produktionslinien zu verwalten.",
    error: "",
    stale: false,
    lineView: "topology",
    editor: null as Editor | null,
    deletion: null as {
      type: "factory" | "line";
      id: string;
      name: string;
      key: string;
    } | null,
    editorError: "",
    invalidField: "",
    intakeFactory: "",
    intakeOpen: false,
    intakeBusy: false,
    policyBusy: false,
    policyLoading: false,
    policyError: "",
    intakeMessage: "",
    queueError: "",
    queue: null as IntakePage | null,
    policy: { mode: "auto", lineId: null, paused: false } as RoutingPolicy,
    policyDrafts: new Map<string, RoutingPolicy>(),
    taskDraft: {
      project: "",
      repository: "",
      reference: "",
      title: "",
      criteria: "",
      provider: "auto",
      execution: "mock",
      lineId: "",
    },
    queueTargets: new Map<string, string>(),
    routingBusy: new Set<string>(),
  });
}

export function createRuntime() {
  return {
    session: 0,
    request: 0,
    queueRequest: 0,
    policyRequest: 0,
    controller: null as AbortController | null,
    intakeIntent: {} as Intent,
  };
}

export type StoreState = ReturnType<typeof createState>;
export type StoreRuntime = ReturnType<typeof createRuntime>;
