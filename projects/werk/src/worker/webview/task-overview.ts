import type { SharedFeatureView } from '../application/shared-intake-contract';
import type { SessionView, LocalTaskboardView } from '../application/workspace-view';
import type { FeatureRequests } from '../application/feature-requests';
import type { WorkerRun } from '../application/run-evidence';
import type { WorkerWorkspace } from '../status/workspace';
import type { RequestSummary } from '../application/request-gates';
import { deliveryLifecycleLabels, deliveryPhaseLabels, deliveryStatusLabels } from './delivery-view';

export type TaskOverviewSource = 'chat' | 'file' | 'assigned' | 'project';
export type TaskOverviewGroup = 'attention' | 'running' | 'queued' | 'completed' | 'draft';
type Sessions = SessionView;
type Board = LocalTaskboardView;
type Features = Awaited<ReturnType<FeatureRequests['list']>>;
type History = Awaited<ReturnType<WorkerWorkspace['history']>>;
type Session = Sessions['records'][number];
type FileTask = Board['tasks'][number];
type Feature = Features['records'][number];
type FeatureFile = Features['files'][number];
type HistoryRow = History['rows'][number];

export interface TaskOverviewInput {
  sessions?: Sessions | null;
  board?: Board | null;
  features?: Features | { enabled: false } | null;
  history?: History | null;
  runs?: readonly WorkerRun[] | null;
  sharedRequests?: readonly SharedFeatureView[] | null;
  requests?: readonly RequestSummary[] | null;
}
export interface TaskOverviewFilter {
  search?: string;
  source?: TaskOverviewSource | 'all';
  includeArchived?: boolean;
}
export interface TaskOverviewAction {
  kind: 'session' | 'review' | 'file' | 'feature' | 'history';
  label: string;
  href: string;
  sessionId?: string;
}
export interface TaskOverviewItem {
  /** Stable presentation identity, separate from retained task/session identifiers. */
  id: string;
  taskId: string;
  sessionId?: string;
  localTaskId?: string;
  requestId?: string;
  featureName?: string;
  title: string;
  summary: string;
  source: TaskOverviewSource;
  sourceLabel: string;
  status: string;
  statusLabel: string;
  group: TaskOverviewGroup;
  provider: string | null;
  model: string | null;
  modelBasis: 'recorded' | 'configured' | 'unavailable';
  modelSnapshot: { provider: string; model: string; runId: string; recordedAt: string; purpose: WorkerRun['purpose'] } | null;
  createdAt: string | null;
  updatedAt: string | null;
  archived: boolean;
  remote: boolean;
  primaryAction: TaskOverviewAction;
  evidenceHref: string;
  deliveryRunId?: string;
  deliveryPhaseLabel?: string;
  lifecycleLabel?: string;
  nextEvent?: string | null;
  priority?: number;
}
export interface TaskOverview {
  items: TaskOverviewItem[];
  groups: Record<TaskOverviewGroup, TaskOverviewItem[]>;
  /** Counts reflect the same search/source/archive filters as items. */
  counts: Record<TaskOverviewGroup, number> & { total: number };
  currentSessionId: string | null;
}
interface Evidence {
  session?: Session;
  file?: FileTask;
  feature?: Feature;
  featureFile?: FeatureFile;
  history?: HistoryRow;
}
const sourceLabels: Record<TaskOverviewSource, string> = { chat: 'Local request', file: 'Local request', assigned: 'Assigned', project: 'Project request' };
const labels: Record<string, string> = {
  draft: 'Draft', queued: 'Queued', running: 'Running', completed: 'Turn completed', done: 'Request done',
  review: 'Review required', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Stopped',
  waiting_input: 'Answer needed', escalated: 'Decision needed', needs_rework: 'Needs rework',
  readiness: 'Readiness check', ready: 'Ready for intake', waiting: 'Waiting for admission',
  simulated: 'Simulated · not implemented', incomplete: 'Incomplete evidence',
  unconfirmed: 'Execution state needs refresh', gate_blocked: 'Gate blocked',
  source_blocked: 'Request source needs attention',
};
const attention = new Set(['waiting_input', 'escalated', 'needs_rework', 'readiness', 'review', 'failed', 'interrupted', 'incomplete', 'unconfirmed', 'gate_blocked', 'source_blocked']);
const timestamp = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
function latest(...values: (string | null | undefined)[]): string | null {
  return values.filter((value): value is string => !!value && !!timestamp(value)).sort((a, b) => timestamp(b) - timestamp(a))[0] ?? null;
}
function groupFor(status: string): TaskOverviewGroup {
  if (attention.has(status)) return 'attention';
  if (status === 'running') return 'running';
  if (['queued', 'ready', 'waiting'].includes(status)) return 'queued';
  if (['completed', 'done', 'cancelled', 'simulated'].includes(status)) return 'completed';
  return 'draft';
}
function historyStatus(row: HistoryRow): string {
  return row.outcome === 'change-set' ? 'review' : row.outcome;
}
function stateFor(evidence: Evidence, currentSessionId: string | null): string {
  const { session, file, feature, featureFile, history } = evidence;
  const sessionId = session?.id ?? file?.sessionId ?? feature?.sessionId;
  if (sessionId && sessionId === currentSessionId) return 'running';
  let status = session?.status ?? file?.status ?? feature?.status ?? featureFile?.status ?? (history ? historyStatus(history) : 'draft');
  // Original assignments keep taskState even if an earlier follow-up left interaction history.
  if (session?.kind === 'orchestrator' && ['queued', 'running'].includes(session.taskState ?? '')) status = session.taskState!;
  const phase = session?.requestPhase ?? file?.requestPhase ?? feature?.gates?.phase;
  // Existing request phases describe outstanding human work independently of a completed model turn.
  if (!['queued', 'running', 'waiting_input', 'escalated', 'failed', 'interrupted', 'cancelled'].includes(status)) {
    // A passed request gate does not apply the retained file patch or clear its review work.
    if (phase === 'done') status = file?.status === 'review' ? 'review' : 'done';
    else if (phase === 'readiness') status = 'needs_rework';
    else if (phase && ['needs_rework', 'review'].includes(phase)) status = phase;
    else if (file?.status === 'review') status = 'review';
  }
  // recordTask appends the original assignment's transcript, but creates no local interaction turn.
  // A real follow-up owns an interaction turn and must retain its own outcome.
  if (history && session?.kind === 'orchestrator' && ['completed', 'done', 'draft'].includes(status) && !session.interaction?.latestTurn) status = historyStatus(history);
  if (featureFile?.error && status === 'draft') status = 'needs_rework';
  if ((feature?.sourceIssue || featureFile?.sourceIssue) && !['done', 'cancelled'].includes(status)) status = 'source_blocked';
  if (status === 'waiting' && (feature?.error || feature?.attention)) status = 'gate_blocked';
  // Only the shared executor can establish that a task currently owns the single execution permit.
  return status === 'running' ? 'unconfirmed' : status;
}
function summarize(evidence: Evidence, status: string): string {
  const { session, file, feature, featureFile, history } = evidence;
  const interaction = session?.interaction ?? file?.interaction;
  if (['waiting_input', 'escalated'].includes(status) && interaction?.pending) return interaction.pending.message;
  if (feature?.sourceIssue || featureFile?.sourceIssue) return feature?.sourceIssue?.reason ?? featureFile?.sourceIssue?.reason ?? '';
  if (feature?.attention) return feature.attention;
  if (status === 'unconfirmed') return 'The retained task state and shared execution slot differ. Refresh to confirm.';
  if (status === 'simulated') return 'Simulation evidence is available. No implementation or applied change is claimed.';
  if (file?.error || feature?.error || featureFile?.error || history?.error) return file?.error || feature?.error || featureFile?.error || history?.error || '';
  if (file?.summary) return file.summary;
  if (status === 'review') return file ? 'A proposed patch is ready for review. It has not been applied automatically.' : 'Review the recorded output and request evidence.';
  if (status === 'needs_rework') return 'Review the request findings before starting another attempt.';
  if (status === 'draft') return featureFile ? 'This project request has not been admitted to the queue.' : 'Add an instruction to start this task.';
  if (status === 'completed' || status === 'done') return 'Inspect the saved result and evidence before accepting the work.';
  if (status === 'queued') return 'Waiting for this worker’s shared execution slot.';
  if (status === 'running') return 'Using this worker’s shared execution slot.';
  return labels[status] ?? status.replaceAll('_', ' ');
}
function primaryAction(item: Pick<TaskOverviewItem, 'sessionId' | 'localTaskId' | 'featureName' | 'status'>): TaskOverviewAction {
  if ((item.sessionId || item.localTaskId) && ['review', 'needs_rework', 'readiness', 'gate_blocked', 'completed', 'done', 'failed', 'interrupted', 'incomplete'].includes(item.status)) {
    const query = new URLSearchParams();
    if (item.sessionId) query.set('session', item.sessionId);
    if (item.localTaskId) query.set('fileId', item.localTaskId);
    return { kind: 'review', label: item.localTaskId ? 'Review changes' : 'Review result', sessionId: item.sessionId, href: '/review?' + query };
  }
  if (item.sessionId) return { kind: 'session', label: ['waiting_input', 'escalated'].includes(item.status) ? 'Answer task' : 'Open task', sessionId: item.sessionId, href: '/taskboard?session=' + encodeURIComponent(item.sessionId) };
  if (item.localTaskId) return { kind: 'file', label: 'Inspect file task', href: '/history' + (['review', 'failed'].includes(item.status) ? '?fileState=' + item.status : '') };
  if (item.featureName) return { kind: 'feature', label: 'Inspect request', href: '/history?view=features' };
  return { kind: 'history', label: 'Inspect execution', href: '/history' };
}
function project(evidence: Evidence, currentSessionId: string | null, runs: readonly WorkerRun[]): TaskOverviewItem {
  const { session, file, feature, featureFile, history } = evidence;
  const remote = session?.kind === 'orchestrator' || feature?.source === 'orchestrator' || featureFile?.source === 'orchestrator' || !!history;
  const sessionId = session?.id ?? file?.sessionId ?? feature?.sessionId;
  const source: TaskOverviewSource = remote ? 'assigned' : feature || featureFile ? 'project' : file || session?.kind === 'local' ? 'file' : 'chat';
  const status = stateFor(evidence, currentSessionId);
  // A prior finished attempt cannot establish the model for a new queued/running turn.
  const inFlight = status === 'running' || status === 'queued';
  const run = runs.filter(value => value.sessionId === sessionId && (!inFlight || ['queued', 'running'].includes(value.outcome))).sort((a, b) => b.sequence - a.sequence)[0];
  const modelSnapshot = run ? { provider: run.provider, model: run.model, runId: run.id, recordedAt: run.acceptedAt, purpose: run.purpose } : null;
  const model = modelSnapshot ? modelSnapshot.model || null : file?.model || session?.definition?.model || null;
  const basis = modelSnapshot ? 'recorded' : model ? 'configured' : 'unavailable';
  const interaction = session?.interaction ?? file?.interaction;
  const identity = sessionId ? 'session:' + sessionId : file ? 'file:' + file.id : feature ? 'feature:' + feature.id : featureFile ? 'feature-file:' + featureFile.name : 'assignment:' + history!.taskId;
  const taskId = feature?.taskId ?? file?.id ?? history?.taskId ?? session?.taskId ?? featureFile?.id ?? '';
  const actionFields = { sessionId, localTaskId: file?.id, featureName: feature?.name ?? featureFile?.name, status };
  return {
    id: identity, taskId, ...actionFields,
    requestId: session?.requestId ?? file?.requestId ?? feature?.gates?.requestId,
    title: session?.title || file?.title || featureFile?.title || history?.title || feature?.name || featureFile?.name || taskId,
    summary: summarize(evidence, status), source, sourceLabel: sourceLabels[source], status,
    statusLabel: labels[status] ?? status.replaceAll('_', ' '), group: groupFor(status),
    provider: modelSnapshot?.provider ?? file?.provider ?? session?.provider ?? featureFile?.provider ?? history?.provider ?? null,
    model, modelBasis: basis, modelSnapshot,
    createdAt: session?.createdAt ?? file?.createdAt ?? feature?.createdAt ?? history?.startedAt ?? null,
    updatedAt: latest(interaction?.latestTurn?.finishedAt, interaction?.latestTurn?.createdAt, feature?.updatedAt, file?.finishedAt, history?.finishedAt, session?.createdAt, file?.createdAt),
    archived: !!(session?.archived || file?.archived || feature?.archived || featureFile?.archived), remote, priority: file?.priority ?? feature?.priority ?? featureFile?.priority,
    primaryAction: primaryAction({ ...actionFields, sessionId: session || file || feature?.submitted ? sessionId : undefined }),
    evidenceHref: sessionId ? '/history?view=runs&runSession=' + encodeURIComponent(sessionId) : '/history',
  };
}
function projectReadyReview(request: SharedFeatureView, currentSessionId: string | null, runs: readonly WorkerRun[]): TaskOverviewItem {
  const review = request.readyReview!;
  const run = runs.find(value => value.sessionId === currentSessionId && value.sessionId === review.sessionId && value.id === review.runId && value.purpose === 'gate_review' && value.outcome === 'running' && !!value.startedAt && !value.after);
  const publicationFailed = request.publication === 'error';
  const blocked = request.status === 'waiting_ready_input' && request.ready?.passed === false;
  const status = publicationFailed ? 'failed' : run ? 'running' : blocked || review.status === 'waiting_input' ? 'waiting_input' : review.status === 'failed' ? 'failed' : review.status === 'running' ? 'unconfirmed' : 'queued';
  const statusLabel = publicationFailed ? 'Publication needs attention' : run ? 'Ready Check running' : blocked ? 'Ready checks need changes' : review.status === 'waiting_input' ? 'Ready Check answers needed' : review.status === 'failed' ? 'Ready Check failed' : review.status === 'running' ? labels.unconfirmed : review.status === 'passed' ? 'Waiting for implementation' : 'Ready Check queued';
  const summary = publicationFailed ? 'The Feature Request update could not be published. Inspect shared intake and resolve the Git publication error before continuing.'
    : status === 'waiting_input' ? 'Answer and update the Feature Request in Markdown, mark it ready, then commit and push for another review.'
    : status === 'failed' ? request.error || 'Inspect the review error before requesting another attempt in the Feature Request.'
    : status === 'unconfirmed' ? 'The retained review and execution slot differ. Refresh to confirm the current state.'
    : status === 'running' ? 'Reviewing the Feature Request before its Definition of Ready check. Implementation has not started.'
    : review.status === 'passed' ? 'The review and Definition of Ready checks passed. Waiting for implementation admission, capacity, and start conditions.'
    : 'Waiting for the worker’s shared execution slot and start conditions. Implementation has not started.';
  return {
    id: 'shared-feature:' + (request.feature?.key ?? request.id), taskId: '', featureName: request.name,
    title: request.title, summary, source: 'project', sourceLabel: 'Project request', status, statusLabel, group: groupFor(status),
    provider: run?.provider ?? null, model: run?.model || null, modelBasis: run ? 'recorded' : 'unavailable',
    modelSnapshot: run ? { provider: run.provider, model: run.model, runId: run.id, recordedAt: run.acceptedAt, purpose: run.purpose } : null,
    createdAt: null, updatedAt: request.updatedAt, archived: false, remote: false,
    primaryAction: { kind: 'feature', label: 'Inspect Ready Check', href: '/settings#shared-intake' },
    evidenceHref: run ? '/history?view=runs&runSession=' + encodeURIComponent(run.sessionId) : '/settings#shared-intake',
  };
}
function withDelivery(item: TaskOverviewItem, requests: readonly RequestSummary[], currentSessionId: string | null): TaskOverviewItem {
  const request = requests.find(row => row.id === item.requestId);
  const run = request?.delivery;
  if (!request || !run) return item;
  const lifecycle = request.lifecycle;
  const working = ['running', 'pause_pending', 'interrupting', 'reconciling'].includes(run.status);
  const group: TaskOverviewGroup = lifecycle === 'done' || lifecycle === 'cancelled' ? 'completed'
    : lifecycle === 'in_review' ? 'attention' : run.status === 'queued' ? 'queued'
      : working && item.sessionId === currentSessionId ? 'running' : 'attention';
  const needsAnswer = ['waiting_input', 'escalated'].includes(item.status);
  const status = lifecycle === 'done' ? 'done' : lifecycle === 'in_review' ? 'review' : needsAnswer ? item.status : run.status;
  const query = new URLSearchParams({ session: item.sessionId ?? request.owner.sessionId });
  if (item.localTaskId) query.set('fileId', item.localTaskId);
  return { ...item, status, group, updatedAt: request.updatedAt,
    statusLabel: lifecycle === 'in_review' || lifecycle === 'done' ? deliveryLifecycleLabels[lifecycle] : needsAnswer ? item.statusLabel : deliveryStatusLabels[run.status],
    summary: needsAnswer ? item.summary : run.decision.reason,
    lifecycleLabel: lifecycle ? deliveryLifecycleLabels[lifecycle] : undefined,
    deliveryRunId: run.id, deliveryPhaseLabel: deliveryPhaseLabels[run.phase], nextEvent: run.decision.waitingFor,
    primaryAction: needsAnswer ? item.primaryAction : { kind: 'review', label: lifecycle === 'in_review' ? 'Review candidate' : 'Inspect request', sessionId: item.sessionId, href: '/review?' + query },
  };
}
/** Pure projection: never dispatches work, mutates snapshots, or treats configuration as execution evidence. */
export function buildTaskOverview(input: TaskOverviewInput, filter: TaskOverviewFilter = {}): TaskOverview {
  const evidence: Evidence[] = (input.sessions?.records ?? []).map(session => ({ session }));
  for (const file of input.board?.tasks ?? []) {
    const existing = evidence.find(item => item.session?.id === file.sessionId || (item.session?.kind === 'local' && item.session.taskId === file.id));
    if (existing) existing.file = file;
    else evidence.push({ file });
  }
  if (input.features?.enabled) {
    for (const feature of input.features.records) {
      const existing = evidence.find(item => (item.session?.id ?? item.file?.sessionId) === feature.sessionId || item.file?.id === feature.taskId);
      if (existing) existing.feature = feature;
      else evidence.push({ feature });
    }
    for (const featureFile of input.features.files) {
      const existing = evidence.find(item => item.feature?.name === featureFile.name);
      if (existing) existing.featureFile = featureFile;
      else evidence.push({ featureFile });
    }
  }
  const newestHistory = new Map<string, HistoryRow>();
  for (const row of input.history?.rows ?? []) {
    const previous = newestHistory.get(row.taskId);
    if (!previous || row.attempt > previous.attempt || (row.attempt === previous.attempt && timestamp(row.finishedAt ?? row.startedAt) > timestamp(previous.finishedAt ?? previous.startedAt))) newestHistory.set(row.taskId, row);
  }
  for (const row of newestHistory.values()) {
    const existing = evidence.find(item => item.feature?.source === 'orchestrator' && item.feature.taskId === row.taskId || item.session?.kind === 'orchestrator' && [row.taskId, 'remote-' + row.taskId].includes(item.session.taskId));
    if (existing) existing.history = row;
    else evidence.push({ history: row });
  }
  const currentSessionId = input.sessions?.execution.currentSessionId ?? null;
  const search = filter.search?.trim().toLocaleLowerCase() ?? '';
  const reviews = (input.sharedRequests ?? []).filter(request => request.isLocal && request.readyReview && !request.taskId).map(request => projectReadyReview(request, currentSessionId, input.runs ?? []));
  const items = [...evidence.map(item => withDelivery(project(item, currentSessionId, input.runs ?? []), input.requests ?? [], currentSessionId)), ...reviews].filter(item =>
    (filter.includeArchived || !item.archived) && (!filter.source || filter.source === 'all' || item.source === filter.source) &&
    (!search || [item.title, item.taskId, item.sessionId, item.localTaskId, item.requestId, item.featureName, item.sourceLabel, item.statusLabel, item.provider, item.model].join(' ').toLocaleLowerCase().includes(search)),
  );
  const groups: TaskOverview['groups'] = { attention: [], running: [], queued: [], completed: [], draft: [] };
  for (const item of items) groups[item.group].push(item);
  const attentionOrder = ['waiting_input', 'escalated', 'needs_rework', 'readiness', 'review', 'failed', 'interrupted', 'incomplete', 'unconfirmed', 'gate_blocked'];
  for (const [name, rows] of Object.entries(groups)) rows.sort((a, b) =>
    (name === 'attention' ? attentionOrder.indexOf(a.status) - attentionOrder.indexOf(b.status) : 0) ||
    (name === 'queued' ? (b.priority ?? 1) - (a.priority ?? 1) || timestamp(a.createdAt) - timestamp(b.createdAt) : timestamp(b.updatedAt) - timestamp(a.updatedAt)) || a.id.localeCompare(b.id),
  );
  return { items, groups, counts: { total: items.length, attention: groups.attention.length, running: groups.running.length, queued: groups.queued.length, completed: groups.completed.length, draft: groups.draft.length }, currentSessionId };
}
