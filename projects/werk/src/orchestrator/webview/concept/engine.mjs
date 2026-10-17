/* Pure, local-only concept simulation. No network, provider, DOM or Git operations. */
export { projects, states, labels, STORAGE_KEY } from './simulation-model.mjs';
import { project } from './simulation-model.mjs';
import { createCatalog } from './simulation-catalog.mjs';
import { createPersistence } from './simulation-persistence.mjs';
import { createScheduling } from './simulation-scheduling.mjs';
import { createIntake } from './simulation-intake.mjs';
import { createContext } from './simulation-context.mjs';
import { createProfiles } from './simulation-profiles.mjs';
import { createEvidence } from './simulation-evidence.mjs';

export function createConceptSimulation(saved) {
  const state = { data: undefined, currentLineId: null, filter: 'all' };
  // Features resolve each other's operations only when invoked, after composition.
  const api = {};
  Object.assign(api,
    createCatalog(state, api),
    createPersistence(state, api),
    createScheduling(state, api),
    createIntake(state, api),
    createContext(state, api),
    createProfiles(state, api),
    createEvidence(state, api),
  );
  state.data = saved === undefined ? api.seed() : api.normalize(saved);
  state.currentLineId = state.data.selectedLineId;
  state.filter = api.selectedLine().projectId;
  return {
    factoryLineSummary: api.factoryLineSummary,
    factoryMapLayout: api.factoryMapLayout,
    addProfile: api.addProfile,
    get data() {
      return state.data;
    },
    get currentLineId() {
      return state.currentLineId;
    },
    get filter() {
      return state.filter;
    },
    set filter(value) {
      if (value !== "all" && !project(value)) throw Error("Projekt fehlt");
      state.filter = value;
    },
    reset() {
      state.data = api.seed();
      api.chooseLine(state.data.selectedLineId);
    },
    replace(value) {
      state.data = api.normalize(value);
      api.chooseLine(state.data.selectedLineId);
    },
    chooseLine: api.chooseLine,
    defaultFactoryCatalog: api.defaultFactoryCatalog,
    validateFactoryCatalog: api.validateFactoryCatalog,
    lineForProject: api.lineForProject,
    selectedLine: api.selectedLine,
    factoryPath: api.factoryPath,
    createFactory: api.createFactory,
    updateFactory: api.updateFactory,
    createLine: api.createLine,
    assignWorkerToLine: api.assignWorkerToLine,
    factoryDescendants: api.factoryDescendants,
    seed: api.seed,
    normalize: api.normalize,
    record: api.record,
    workerTasks: api.workerTasks,
    busy: api.busy,
    freeSlots: api.freeSlots,
    available: api.available,
    boundedInteger: api.boundedInteger,
    taskList: api.taskList,
    workerList: api.workerList,
    workerStatus: api.workerStatus,
    waitReason: api.waitReason,
    release: api.release,
    advance: api.advance,
    taskAction: api.taskAction,
    updateWorker: api.updateWorker,
    addTask: api.addTask,
    addWorker: api.addWorker,
    topology: api.topology,
    repoNotes: api.repoNotes,
    parseWiki: api.parseWiki,
    resolveWiki: api.resolveWiki,
    resolveContext: api.resolveContext,
    contextManifest: api.contextManifest,
    defaultProfiles: api.defaultProfiles,
    validProfiles: api.validProfiles,
    profileName: api.profileName,
    profileState: api.profileState,
    eligibleProfiles: api.eligibleProfiles,
    setProfileState: api.setProfileState,
    validateContext: api.validateContext,
    reviseTaskRequirement: api.reviseTaskRequirement,
    addVaultTask: api.addVaultTask,
    applyWorkerConfiguration: api.applyWorkerConfiguration,
    importIterationFeatures: api.importIterationFeatures,
    demoSnapshot: api.demoSnapshot,
    snapshotSeries: api.snapshotSeries,
  };
}
