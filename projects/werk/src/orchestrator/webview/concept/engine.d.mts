export interface Project {
  id: string;
  name: string;
  team: string;
  stack: string;
  repo: string;
  color: string;
}
export interface Factory {
  id: string;
  name: string;
  parentId: string | null;
}
export interface Line {
  id: string;
  name: string;
  factoryId: string;
  projectId: string;
  orchestratorId: string;
}
export type TaskState =
  | "queued"
  | "running"
  | "checks"
  | "review"
  | "changes"
  | "blocked"
  | "done";
export interface Profile {
  id: string;
  provider: string;
  label: string;
  enabled: boolean;
  authenticated: boolean;
  limited: boolean;
  maxParallel: number;
  authMode: string;
}
export interface Worker {
  id: string;
  project: string;
  lineId: string;
  online: boolean;
  paused: boolean;
  quota: boolean;
  maxParallel: number;
  systemPrompt: string;
  timeoutSeconds: number;
  configVersion: number;
  profiles: Profile[];
}
export interface Snapshot {
  id: string;
  phase: "before" | "after";
  attempt: number;
  taskId: number;
  tick: number;
  source: string;
  artifactPath: string;
  capturedAt: string;
  execution: {
    outcome: string;
    durationMs: number | null;
    elapsedTicks: number | null;
    reason: string;
  };
  resources: {
    rssBytes: number | null;
    cpuTimeMs: number | null;
    reason: string;
  };
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    providerReportedCostUsd: number | null;
    reason: string;
  };
  quality: { state: string; coveragePercent: number | null };
}
export interface ContextReference {
  raw: string;
  path: string;
  anchor?: string;
  selector?: string;
  excerpt: string;
}
export interface ContextManifest {
  schemaVersion: number;
  projectId: string;
  baseCommit: string;
  baseRef: string;
  vaultRoot: string;
  source: string;
  references: ContextReference[];
}
export interface Task {
  id: number;
  title: string;
  project: string;
  lineId: string;
  provider: string;
  criteria: string;
  priority: number;
  status: TaskState;
  worker: string | null;
  attempt: number;
  failures: number;
  approved: boolean;
  merged?: boolean;
  check: string;
  pr: number | null;
  lease: string | null;
  execution: { provider: string; profileId: string } | null;
  iterationBranch: string;
  blockReason?: string;
  lastWorkerId?: string;
  requirementRef?: string;
  requirementResolution?: string;
  intakeRevision?: number;
  sourceFeatureId?: string;
  sourceCommit?: string;
  context?: ContextManifest;
  snapshots?: Snapshot[];
  history: { tick: number; text: string }[];
}
export interface ConceptData {
  schema: number;
  factories: Factory[];
  lines: Line[];
  selectedLineId: string;
  workers: Worker[];
  tasks: Task[];
  events: {
    tick: number;
    time: string;
    text: string;
    lineId?: string;
    project?: string;
  }[];
  tick: number;
  next: number;
  prNext: number;
}
export interface TaskInput {
  project: string;
  lineId?: string;
  title: string;
  criteria: string;
  provider?: string;
  priority?: number;
  requirementRef?: string;
}
export interface Resolution {
  ok: boolean;
  entries: {
    raw: string;
    repoPath?: string;
    path?: string;
    excerpt?: string;
    error?: string;
    selector?: string;
    anchor?: string;
    candidates?: unknown[];
  }[];
  errors: string[];
}
export interface ConceptSimulation {
  readonly data: ConceptData;
  readonly currentLineId: string | null;
  filter: string;
  seed(): ConceptData;
  normalize(raw: unknown): ConceptData;
  reset(): void;
  replace(raw: unknown): void;
  chooseLine(id: string): Line;
  lineForProject(projectId: string, lineId?: string | null): Line;
  selectedLine(): Line;
  factoryPath(id: string): string;
  factoryDescendants(id: string): Set<string>;
  createFactory(name: string, parentId?: string | null): Factory;
  updateFactory(id: string, name: string, parentId: string | null): Factory;
  createLine(factoryId: string, name: string, projectId: string): Line;
  assignWorkerToLine(workerId: string, lineId: string): Worker;
  advance(): number;
  taskAction(id: number, action: string): boolean;
  updateWorker(id: string, action: string): boolean;
  addTask(values: TaskInput): Task;
  addWorker(projectId: string, lineId?: string | null): string;
  taskList(): Task[];
  workerList(): Worker[];
  workerTasks(worker: Worker): Task[];
  busy(worker: Worker): Task | undefined;
  freeSlots(worker: Worker, task?: Task | null): number;
  available(worker: Worker, task?: Task | null): boolean;
  workerStatus(worker: Worker): string;
  waitReason(task: Task): string;
  profileName(id: string): string;
  profileState(profile: Profile): string;
  eligibleProfiles(worker: Worker, task?: Task | null): Profile[];
  setProfileState(workerId: string, profileId: string, action: string): boolean;
  addProfile(workerId: string, provider: string): Profile;
  applyWorkerConfiguration(
    worker: Worker,
    config: {
      maxParallel: number;
      timeoutSeconds: number;
      systemPrompt: string;
      profiles: { id: string; maxParallel: number }[];
    },
  ): void;
  importIterationFeatures(projectId: string, lineId?: string | null): number;
  addVaultTask(
    projectId: string,
    requirementRef: string,
    lineId?: string | null,
  ): Task;
  reviseTaskRequirement(id: number, reference: string): Task;
  repoNotes(
    projectId: string,
  ): { path: string; aliases: string[]; text: string }[];
  parseWiki(raw: string): { error?: string; raw: string; path?: string };
  resolveWiki(
    raw: string,
    projectId: string,
  ): {
    error?: string;
    raw: string;
    repoPath?: string;
    excerpt?: string;
    selector?: string;
    candidates?: unknown[];
  };
  resolveContext(text: string, projectId: string): Resolution;
  contextManifest(draft: { project: string; links: string }): ContextManifest;
  validateContext(context: ContextManifest, projectId: string): void;
  record(text: string, task?: Task | null): void;
  release(task: Task): void;
  demoSnapshot(task: Task, phase: string, outcome?: string): void;
  snapshotSeries(): { task: Task; before?: Snapshot; after: Snapshot }[];
  factoryLineSummary(line: Line): {
    workers: Worker[];
    tasks: Task[];
    slots: number;
    active: number;
    free: number;
    profiles: number;
    waiting: number;
    review: number;
  };
  factoryMapLayout(factoryId: string): {
    boxes: unknown[];
    lanes: unknown[];
    width: number;
    height: number;
  };
  topology(lineId?: string | null): {
    nodes: {
      id: string;
      kind: string;
      x: number;
      z: number;
      name: string;
      sub: string;
      color: string;
    }[];
    edges: { from: string; to: string; kind: string; color: string }[];
  };
}
export const STORAGE_KEY: string;
export const projects: Project[];
export const states: TaskState[];
export const labels: Record<TaskState, string>;
export function createConceptSimulation(saved?: unknown): ConceptSimulation;
