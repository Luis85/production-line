import { DomainError } from '../../shared/errors.js';
import { canonicalJson, gateDigest } from './request-gates.js';
import { featureContentHash, featureWorkflowPath, featureWorkflowSources } from './feature-workflow.js';
import type { FeatureAuthoringBinding, FeatureAuthoringCommand, FeatureAuthoringPorts, FeatureAuthoringResult } from './feature-authoring-contracts.js';

const revision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
function conflict(message: string): never { throw new DomainError('conflict', message); }
function command(value: unknown): FeatureAuthoringCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Feature authoring requires a command.');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['action', 'operationId', 'name', 'markdown', 'seed', 'expectedRevision', 'expectedWorkflowDigest', 'expectedBinding', 'status'].includes(key))) invalid('Unknown feature authoring field.');
  if (typeof body.action !== 'string' || !['prepare', 'publish'].includes(body.action) || typeof body.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.operationId)) invalid('Use prepare or publish with a stable operation ID.');
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.length > 200 || body.name.startsWith('_') || body.name.includes('/') || !/\.md$/i.test(body.name)) invalid('Use a top-level Markdown filename outside generated underscore folders.');
    featureWorkflowPath(body.name, 'Feature filename');
  }
  if (body.markdown !== undefined && (typeof body.markdown !== 'string' || Buffer.byteLength(body.markdown) > 65536)) invalid('Feature Markdown must be bounded text.');
  if (body.status !== undefined && (body.action !== 'publish' || typeof body.status !== 'string' || !['draft', 'ready'].includes(body.status))) invalid('Set draft or ready only when publishing.');
  if (body.seed !== undefined && (body.action !== 'prepare' || body.markdown !== undefined)) invalid('A template seed is only used when preparing a new draft without Markdown.');
  if (body.expectedBinding !== undefined) {
    const binding = body.expectedBinding as Record<string, unknown>;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).sort().join(',') !== 'branch,remote,repositoryId,workflowPath' || Object.values(binding).some(value => typeof value !== 'string')) invalid('Use the complete binding returned by prepare.');
  }
  if (body.expectedRevision !== undefined && body.expectedRevision !== null && !revision(body.expectedRevision)) invalid('Use the current request revision or null for a new request.');
  if (body.expectedWorkflowDigest !== undefined && !revision(body.expectedWorkflowDigest)) invalid('Use the workflow digest returned by prepare.');
  if (body.action === 'publish' && (body.name === undefined || body.markdown === undefined || !Object.hasOwn(body, 'expectedRevision') || body.expectedWorkflowDigest === undefined || body.expectedBinding === undefined)) invalid('Publish requires the name, Markdown, expected revision, workflow digest and binding returned by prepare.');
  return body as unknown as FeatureAuthoringCommand;
}
function bindingMatches(actual: FeatureAuthoringBinding, expected?: FeatureAuthoringBinding) {
  if (expected && canonicalJson(actual) !== canonicalJson(expected)) conflict('The shared repository binding changed. Reopen the request before publishing.');
}

/** Authoring publishes the central request. The existing intake remains the only execution owner. */
export class SharedFeatureAuthoring {
  private readonly ports: FeatureAuthoringPorts;
  private readonly shutdown?: AbortSignal;
  constructor(ports: FeatureAuthoringPorts, shutdown?: AbortSignal) { this.ports = ports; this.shutdown = shutdown; }
  async command(value: unknown, signal: AbortSignal = new AbortController().signal): Promise<FeatureAuthoringResult> {
    signal = AbortSignal.any([signal, ...(this.shutdown ? [this.shutdown] : [])]);
    signal.throwIfAborted();
    const input = command(value), configured = this.ports.binding();
    if (!configured?.repositoryId) conflict('Configure shared repository intake before authoring a team feature request.');
    const binding = structuredClone(configured);
    bindingMatches(binding, input.expectedBinding);
    const reader = this.ports.repository(binding), commit = await reader.head(signal);
    const workflow = await this.ports.loadWorkflow(reader, commit, binding.workflowPath, signal);
    const workflowFiles = featureWorkflowSources(workflow);
    const workflowDigest = gateDigest(workflowFiles);
    if (input.action === 'prepare' && input.expectedWorkflowDigest && input.expectedWorkflowDigest !== workflowDigest) conflict('The shared template or checks changed. Prepare the request again before publishing.');
    const repository = this.ports.repository(binding, workflow);
    const seedId = 'fr-' + gateDigest(input.operationId).slice(0, 24), name = input.name ?? seedId + '.md';
    const path = workflow.configuration.requestsDirectory + '/' + name;
    const previous = await repository.readBlob(commit, path, signal);
    if (input.seed && previous !== null) conflict('This request already exists. Reopen its Markdown to continue authoring.');
    if (input.action === 'prepare' && Object.hasOwn(input, 'expectedRevision') && input.expectedRevision !== (previous === null ? null : featureContentHash(previous))) conflict('The feature request changed remotely. Reopen it before editing.');
    const authored = input.markdown ?? previous ?? this.ports.documents.prepare(workflow, seedId, input.seed);
    const markdown = input.status ? this.ports.documents.status(authored, input.status) : authored;
    const document = this.ports.documents.inspect(markdown);
    const readiness = this.ports.documents.ready(markdown, workflow);
    const templates = workflow.templates?.map(({ id, label, path, default: defaultTemplate }) => ({ id, label, path, default: defaultTemplate })) ?? (document.templateId ? [{ id: document.templateId, label: 'Default Feature Request', path: workflow.configuration.template, default: true }] : undefined);
    const result: FeatureAuthoringResult = { ...(document.templateId ? { templateId: document.templateId } : {}), ...(templates ? { templates } : {}), featureId: document.id, name, path, markdown, revision: previous === null ? null : featureContentHash(previous), status: document.status, readiness, workflowDigest, binding };
    if (input.action === 'prepare') return result;
    const readinessError = document.status === 'ready' && !readiness.valid ? 'The feature request is not ready: ' + readiness.errors.map(error => error.message).join(' ') : undefined;
    // Recheck the selected target after reads; callers also serialize configuration changes with publication.
    const current = this.ports.binding();
    if (!current) conflict('Shared repository intake was disconnected.');
    bindingMatches(current, binding);
    const publication = await repository.publishRequest({ operationId: input.operationId, request: { path, expectedRevision: input.expectedRevision!, content: markdown }, workflowFiles, workflowDigest: input.expectedWorkflowDigest!, binding, ...(readinessError ? { readinessError } : {}) }, signal);
    // A confirmed publication is durable even if a subsequent synchronization cannot run yet.
    await this.ports.sync().catch(() => undefined);
    return { ...result, revision: featureContentHash(markdown), publication, workflowDigest: input.expectedWorkflowDigest!, ...(publication.replayed && document.status === 'ready' ? { readiness: { ...readiness, valid: true, errors: [] } } : {}) };
  }
}
