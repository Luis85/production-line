import type { FeatureAuthoringBinding, FeatureAuthoringCommand, FeatureAuthoringResult } from '../application/feature-authoring-contracts';

export interface FeatureAuthoringEditorState {
  result: FeatureAuthoringResult | null;
  markdown: string;
  checkedMarkdown: string;
  savedMarkdown: string;
  pending: FeatureAuthoringCommand | null;
  busy: boolean;
  error: string;
  notice: string;
}
export const emptyFeatureAuthoringEditor = (): FeatureAuthoringEditorState => ({ result: null, markdown: '', checkedMarkdown: '', savedMarkdown: '', pending: null, busy: false, error: '', notice: '' });
interface Ports {
  state: FeatureAuthoringEditorState;
  binding(): FeatureAuthoringBinding | null;
  active(): boolean;
  epoch(): number;
  uuid(): string;
  command(command: FeatureAuthoringCommand): Promise<FeatureAuthoringResult>;
}
const equalBinding = (a: FeatureAuthoringBinding, b: FeatureAuthoringBinding | null) => !!b && a.repositoryId === b.repositoryId && a.remote === b.remote && a.branch === b.branch && a.workflowPath === b.workflowPath;
/** Browser editing and exact request replay only; lifecycle authority remains on the worker. */
export function createFeatureAuthoringEditor(ports: Ports) {
  const state = ports.state;
  function current() { return !!state.result && equalBinding(state.result.binding, ports.binding()); }
  function editable() { return current() && !(state.result?.revision && state.result.status === 'ready'); }
  function reset() { Object.assign(state, emptyFeatureAuthoringEditor()); }
  async function run(command: FeatureAuthoringCommand) {
    if (!ports.active() || state.busy) return;
    const epoch = ports.epoch(), binding = ports.binding();
    if (!binding) return;
    const sent = JSON.parse(JSON.stringify(command)) as FeatureAuthoringCommand;
    state.pending = sent; state.busy = true; state.error = ''; state.notice = '';
    try {
      const result = await ports.command(sent);
      if (epoch !== ports.epoch() || !ports.active()) return;
      if (!equalBinding(binding, ports.binding()) || !equalBinding(result.binding, binding)) throw Error('The shared repository connection changed. Your input is retained; reopen the request from its original repository.');
      if (!result.featureId || !result.name || typeof result.markdown !== 'string' || !result.readiness || !result.workflowDigest)
        throw Error('The worker did not confirm this feature request. Retry the same operation.');
      if (sent.action === 'publish' || sent.action === 'prepare' && sent.markdown === undefined) state.savedMarkdown = result.revision ? result.markdown : '';
      state.result = result; state.markdown = result.markdown; state.checkedMarkdown = result.markdown; state.pending = null;
      state.notice = result.publication ? result.status === 'ready' ? 'Ready request committed and pushed. The worker will claim it when eligible.' : 'Draft committed and pushed. Your team can edit the same request in Markdown.' : 'Draft prepared from the project template. Complete the details before publishing.';
      return result;
    } catch (error) {
      if (epoch !== ports.epoch() || !ports.active()) return;
      state.error = error instanceof Error ? error.message : 'The request could not be confirmed.';
      const status = (error as { status?: number })?.status;
      if (status === 400 || status === 409 || status === 404) state.pending = null;
    } finally { if (epoch === ports.epoch()) state.busy = false; }
  }
  function prepare(seed: NonNullable<FeatureAuthoringCommand['seed']>) {
    if (state.pending || state.result) return Promise.resolve(undefined);
    return run({ action: 'prepare', operationId: ports.uuid(), seed, expectedBinding: ports.binding()! });
  }
  function reopen(name: string) {
    if (state.pending || state.busy) return Promise.resolve(undefined);
    return run({ action: 'prepare', operationId: ports.uuid(), name, expectedBinding: ports.binding()! });
  }
  function check() {
    if (!editable() || state.pending || !state.result) return Promise.resolve(undefined);
    return run({ action: 'prepare', operationId: ports.uuid(), name: state.result.name, markdown: state.markdown,
      expectedRevision: state.result.revision, expectedWorkflowDigest: state.result.workflowDigest, expectedBinding: state.result.binding });
  }
  function publish(status: 'draft' | 'ready') {
    if (!editable() || state.pending || !state.result) return Promise.resolve(undefined);
    if (status === 'ready' && (state.markdown !== state.checkedMarkdown || !state.result.readiness.valid)) return Promise.resolve(undefined);
    return run({ action: 'publish', operationId: ports.uuid(), name: state.result.name, markdown: state.markdown, status,
      expectedRevision: state.result.revision, expectedWorkflowDigest: state.result.workflowDigest, expectedBinding: state.result.binding });
  }
  function retry() {
    if (!state.pending || state.busy || !equalBinding(state.pending.expectedBinding!, ports.binding())) return Promise.resolve(undefined);
    return run(state.pending);
  }
  return { current, editable, reset, prepare, reopen, check, publish, retry };
}
