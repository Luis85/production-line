import { DomainError } from '../../../shared/errors.js';
import type { FeatureAuthoringDocuments, FeatureAuthoringSeed } from '../../application/feature-authoring-contracts.js';
import type { FeatureWorkflowSnapshot } from '../../application/feature-workflow.js';
import { providerIds } from '../../application/provider-contract.js';
import { parseFeature } from './document.js';
import { validateFeatureReadiness, replaceFeatureSection } from './workflow.js';

function invalid(message: string): never { throw new DomainError('invalid_input', message); }
function parse(markdown: string) {
  try { return parseFeature(markdown); } catch (error) { return invalid(error instanceof Error ? error.message : 'Invalid feature Markdown.'); }
}
function inspect(markdown: string) {
  const { data } = parse(markdown);
  if (typeof data.id !== 'string' || data.id.startsWith('remote-')) invalid('A team request requires a stable feature ID.');
  if (data.status !== 'draft' && data.status !== 'ready') invalid('Only unclaimed draft or ready requests can be authored. Open the running request to answer or follow its progress.');
  if (data.mode !== 'patch' || typeof data.templateId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(data.templateId)) invalid('Use the configured feature template and patch mode.');
  if (['source', 'werk', 'werkOwner', 'werkTask', 'werkPullRequest', 'werkTracking'].some(key => Object.hasOwn(data, key)) || data.type === 'Task' || data.type === 'PullRequest') invalid('Authoring cannot replace worker-owned lifecycle or companion notes.');
  if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 120) invalid('Give the request a title of 1–120 characters.');
  return { id: data.id, status: data.status as 'draft' | 'ready' };
}
function seedInput(value: FeatureAuthoringSeed): FeatureAuthoringSeed {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['title', 'message', 'provider', 'paths', 'definitionRef', 'agent', 'useInstructionsOnly'].includes(key))) invalid('Invalid feature draft seed.');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 120 || typeof value.message !== 'string' || value.message.length > 8000) invalid('Provide a bounded title and request message.');
  if (!providerIds.includes(value.provider as typeof providerIds[number])) invalid('Choose a supported model connection.');
  if (value.paths !== undefined && (!Array.isArray(value.paths) || value.paths.length > 32 || value.paths.some(path => typeof path !== 'string' || !path || path.length > 1024))) invalid('Approved paths must be a bounded file list.');
  if (value.definitionRef !== undefined && (typeof value.definitionRef !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value.definitionRef))) invalid('Use a stable definition reference.');
  if (value.agent !== undefined && (typeof value.agent !== 'string' || !value.agent || value.agent.length > 100)) invalid('Use a bounded agent name.');
  if (value.useInstructionsOnly !== undefined && typeof value.useInstructionsOnly !== 'boolean') invalid('useInstructionsOnly must be true or false.');
  return value;
}
function prepare(snapshot: FeatureWorkflowSnapshot, featureId: string, supplied?: FeatureAuthoringSeed) {
  const parsed = parseFeature(snapshot.template), seed = supplied && seedInput(supplied);
  parsed.document.set('id', featureId); parsed.document.set('status', 'draft');
  let body = parsed.body;
  if (seed) {
    parsed.document.set('title', seed.title.trim()); parsed.document.set('provider', seed.provider);
    if (seed.paths !== undefined) parsed.document.set('paths', seed.paths);
    for (const key of ['definitionRef', 'agent', 'useInstructionsOnly'] as const) if (seed[key] !== undefined) parsed.document.set(key, seed[key]);
    if (seed.definitionRef !== undefined) parsed.document.delete('definitionId');
    if (seed.message.trim()) body = replaceFeatureSection(body, 'goal', seed.message);
  }
  const markdown = '---\n' + parsed.document.toString({ lineWidth: 0 }) + '---\n' + body;
  inspect(markdown);
  return markdown;
}
export const featureAuthoringDocuments: FeatureAuthoringDocuments = {
  prepare, inspect,
  status(markdown, status) {
    const parsed = parse(markdown); parsed.document.set('status', status);
    return '---\n' + parsed.document.toString({ lineWidth: 0 }) + '---\n' + parsed.body;
  },
  ready(markdown, snapshot) {
    const result = validateFeatureReadiness(markdown, snapshot.readyCheck, undefined, snapshot.template, { configuration: snapshot.configuration, workflowPath: snapshot.files.configuration.path });
    return { valid: result.valid, errors: result.errors };
  },
};
