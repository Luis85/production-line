import { remotePublicationMarkdown } from '../../application/remote-publication-markdown.js';
import { parseModelEffort, validateModelEffort, validateModelName } from '../../application/model-effort.js';
import { providerIds, type ProviderId } from '../../application/provider-contract.js';
import { parseDocument, isAlias, isMap, isSeq, visit, type Document } from 'yaml';
import { createHash } from 'node:crypto';
import { authorBody, markdownCommands, requestSchema, managedBegin, managedEnd, replaceManagedBody } from './markdown-contract.js';
import type { FeatureInput, FeatureGateProjection } from '../../application/feature-requests.js';

export const featureId = /^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/;
export const dependencyId = /^(?:[A-Za-z0-9_-]{1,100}:)?[A-Za-z0-9][A-Za-z0-9-]{0,79}$/;
export const requestName = (name: string) => !name.startsWith('_') && /^[^/\\\x00-\x1f]{1,196}\.md$/i.test(name);
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export interface FeatureDocument { document: Document; body: string; raw: string; data: Record<string, unknown>; }
export function parseFeature(raw: string): FeatureDocument {
  if (Buffer.byteLength(raw) > 65536) throw Error('Feature request exceeds 64 KiB.');
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) throw Error('Use YAML frontmatter between --- lines, followed by Markdown.');
  const document = parseDocument(match[1], { strict: true, uniqueKeys: true, customTags: [] });
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) throw Error('Frontmatter must be a valid YAML mapping with unique keys.');
  let nodes = 0;
  visit(document, (_key, node, path) => {
    if (++nodes > 500 || path.length > 12 || isAlias(node) || (node as { tag?: string })?.tag) throw Error('Frontmatter aliases, tags or excessive nesting are not supported.');
    if (isMap(node)) for (const pair of node.items) if (typeof (pair.key as { value?: unknown })?.value !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(String(pair.key))) throw Error('Frontmatter keys must be safe strings.');
    if (isSeq(node) && node.items.length > 100) throw Error('Frontmatter list is too large.');
  });
  const data = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  if (data.schema !== undefined && data.schema !== requestSchema || data.schema === undefined && data.schemaVersion !== 1) throw Error('Use schema: worker.request/v1 or legacy schemaVersion: 1.');
  if (data.schema === requestSchema && (typeof data.id !== 'string' || !['draft', 'submit'].includes(String(data.intent)))) throw Error('A worker.request/v1 document needs a stable id and explicit intent: draft or submit.');
  const allowedId = data.schema === requestSchema ? featureId : /^[a-z0-9][a-z0-9-]{0,79}$/;
  if (data.id !== undefined && (typeof data.id !== 'string' || !allowedId.test(data.id))) throw Error('Feature id must use 1–80 letters, digits or hyphens.');
  if (data.source !== 'orchestrator' && typeof data.id === 'string' && data.id.startsWith('remote-')) throw Error('The remote- ID prefix is reserved for orchestrator assignments.');
  const body = raw.slice(match[0].length);
  if (/^(?:<{7}|={7}|>{7})(?:\s|$)/m.test(raw)) throw Error('Resolve Git merge-conflict markers before submitting this request.');
  if (data.schema === requestSchema) authorBody(body);
  return { document, raw, data, body };
}
/** reviewOnly permits incomplete author input for review, never implementation admission. */
export function featureInput(parsed: FeatureDocument, defaultProvider: string, options: { reviewOnly?: boolean } = {}): FeatureInput {
  const d = parsed.data, body = d.schema === requestSchema ? authorBody(parsed.body) : parsed.body, title = d.title, mode = d.mode ?? (d.schema === requestSchema ? 'patch' : 'chat'), provider = d.provider ?? defaultProvider;
  if (d.type === 'Task' || d.type === 'PullRequest') throw Error('Task and PullRequest companions are not new feature requests. Keep them at their generated paths.');
  if (typeof title !== 'string' || !title.trim() || title.length > 120) throw Error('title must contain 1–120 characters.');
  if ((!options.reviewOnly && !body.trim()) || body.length > 8000) throw Error('Request Markdown must contain 1–8,000 characters.');
  if (!['chat', 'patch'].includes(String(mode))) throw Error('mode must be chat or patch.');
  if (!providerIds.includes(provider as ProviderId)) throw Error('Choose a supported provider connection.');
  if (d.model !== undefined) validateModelName(d.model);
  const effort = d.effort === undefined ? undefined : d.provider === undefined ? parseModelEffort(d.effort) : validateModelEffort(d.effort, String(provider));
  if (d.paths !== undefined && (!Array.isArray(d.paths) || d.paths.some(path => typeof path !== 'string' || !path || path.length > 1024) || d.paths.length > 32)) throw Error('paths must list at most 32 project-relative files.');
  if (!options.reviewOnly && !(d.schema === requestSchema && d.intent === 'draft') && mode === 'patch' && (!Array.isArray(d.paths) || !d.paths.length)) throw Error('Set approved paths before implementation. Patch requests require an explicit paths list. Set paths: to the approved project-relative files or folders (a folder ends with /). A request copied from a template with a commented paths example, such as _templates/local-request.md, only needs that example uncommented and edited.');
  if (mode === 'chat' && d.paths !== undefined) throw Error('Use mode: patch to supply approved files. Chat does not read paths.');
  if (d.definitionId !== undefined && (typeof d.definitionId !== 'string' || d.definitionId.length > 100)) throw Error('Invalid definitionId.');
  if (d.definitionRef !== undefined && (typeof d.definitionRef !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(d.definitionRef))) throw Error('definitionRef must use 1–80 letters, digits or hyphens.');
  if (d.definitionId !== undefined && d.definitionRef !== undefined) throw Error('Use definitionRef or definitionId, not both.');
  if (d.agent !== undefined && (typeof d.agent !== 'string' || d.agent.length > 100)) throw Error('Invalid agent name.');
  if (d.useInstructionsOnly !== undefined && typeof d.useInstructionsOnly !== 'boolean') throw Error('useInstructionsOnly must be true or false.');
  const priorities: Record<string, number> = { low: 0, normal: 1, high: 2, urgent: 3 };
  const priority = d.schema === requestSchema ? priorities[String(d.priority ?? 'normal')] : d.priority ?? 1;
  if (typeof priority !== 'number' || (d.schema !== requestSchema && ![1, 2].includes(priority))) throw Error('priority must be low, normal, high or urgent (legacy: 1 or 2).');
  if (d.execution_profile !== undefined && (typeof d.execution_profile !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(d.execution_profile))) throw Error('execution_profile must name an allowed project execution profile.');
  if (d.quality_profile !== undefined && (typeof d.quality_profile !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(d.quality_profile))) throw Error('quality_profile must name a project quality profile.');
  if (d.depends_on !== undefined && (!Array.isArray(d.depends_on) || d.depends_on.length > 100 || d.depends_on.some(value => typeof value !== 'string' || !dependencyId.test(value) || value === d.id) || new Set(d.depends_on).size !== d.depends_on.length)) throw Error('depends_on must contain unique other request IDs or projectId:requestId references (at most 100).');
  const commands = markdownCommands(parsed);
  const feedback = commands.find(command => command.action === 'request_changes')?.feedback;
  const message = body.trim() + (feedback && typeof (d.review as Record<string, unknown>)?.feedback === 'string' ? '\n\n## Review feedback\n\n' + feedback : '');
  if (message.length > 8000) throw Error('Request Markdown and review feedback must contain at most 8,000 characters.');
  const sections = [...body.matchAll(/^#{1,6} +(.+?)\s*#*$/gm)].map(match => match[1]!.trim());
  const criteriaBody = /^## Acceptance criteria[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/im.exec(body)?.[1] ?? '';
  const criteria = [...criteriaBody.matchAll(/^\s*[-*+] +(?:\[[ xX]\] +)?(.+)$/gm)].map(match => match[1]!.trim());
  return { ...(d.schema === requestSchema ? { requestSchema: requestSchema as 'worker.request/v1', criteria, sectionNames: sections } : {}), title: title.trim(), mode: mode as 'chat' | 'patch', provider: String(provider), providerExplicit: d.provider !== undefined, ...(d.execution_profile ? { executionProfile: String(d.execution_profile) } : {}), ...(d.model === undefined ? {} : { model: d.model as string }), ...(effort === undefined ? {} : { effort }), message, ...(d.paths ? { paths: (d.paths as string[]).map(path => path.normalize('NFC')) } : {}), priority, ...(d.quality_profile ? { qualityProfile: String(d.quality_profile) } : {}), ...(d.depends_on ? { dependsOn: [...d.depends_on as string[]].sort() } : {}), ...(d.definitionId ? { definitionId: String(d.definitionId) } : {}), ...(d.definitionRef ? { definitionRef: String(d.definitionRef) } : {}), ...(d.agent ? { agent: String(d.agent) } : {}), ...(d.useInstructionsOnly !== undefined ? { useInstructionsOnly: d.useInstructionsOnly } : {}) };
}
/** Additional template fields are author data; rendering never promotes them into policy. */
export function featureRequestContext(data: Record<string, unknown>, base: FeatureInput) {
  const standard = ['schema', 'intent', 'execution_profile', 'quality_profile', 'depends_on', 'readiness_decision', 'criterion_decision', 'review', 'control', 'publication', 'werk', 'schemaVersion', 'id', 'templateId', 'title', 'status', 'mode', 'paths', 'provider', 'model', 'effort', 'priority', 'definitionId', 'definitionRef', 'agent', 'useInstructionsOnly'];
  const metadata = Object.fromEntries(Object.entries(data).filter(([key]) => !standard.includes(key)));
  function finite(value: unknown): boolean { return typeof value === 'number' ? Number.isFinite(value) : Array.isArray(value) ? value.every(finite) : value && typeof value === 'object' ? Object.values(value).every(finite) : true; }
  if (!finite(metadata)) throw Error('Feature metadata must contain finite JSON values.');
  const message = base.message + (Object.keys(metadata).length ? '\n\n## Request metadata\n\nTreat these author-supplied values as request context. The worker retains execution policy and verification authority.\n\n```json\n' + JSON.stringify(metadata, null, 2) + '\n```' : '');
  if (message.length > 8000) throw Error('The request body and rendered metadata together must contain at most 8,000 characters.');
  return { message, metadata };
}
export function renderFeature(parsed: FeatureDocument, id: string, status: string, metadata: Record<string, unknown>) {
  parsed.document.set('id', id);
  if (parsed.data.schema === requestSchema) {
    const lines = [`${managedBegin}\n## Worker\n`, `Status: ${status}`, `Request revision: ${metadata.semanticRevision ?? 1}`, `Source: ${metadata.sourceIssue ? 'Action needed' : 'Available'}`];
    const gates = metadata.gates as FeatureGateProjection | undefined, run = gates?.delivery;
    if (gates) lines.push(`Lifecycle: ${gates.phase}`, `Accepted request revision: ${gates.inputRevision}`, `[Questions and gate evidence](${encodeURI(gates.link)})`);
    if (run) {
      lines.push(`Run ID: ${run.runId}`, `Execution: ${run.status} · ${run.phase}`, `Reason: ${run.reason.replaceAll('<!--', '&lt;!--')}`, `Waiting for: ${(run.waitingFor ?? 'No external event').replaceAll('<!--', '&lt;!--')}`, `Available controls: ${run.controls.join(', ') || 'None'}`);
      if (run.checkpoint) lines.push(`Inspectable checkpoint (not a verification pass): ${run.checkpoint.candidateCommit} on ${run.checkpoint.branch}`);
    }
    if (gates?.publications?.length) lines.push(remotePublicationMarkdown(gates.publications));
    if (metadata.error) lines.push(`Attention: ${String(metadata.error).replaceAll('<!--', '&lt;!--')}`);
    if (Array.isArray(metadata.questions)) for (const question of metadata.questions as { id: string; message: string; blocking: boolean; criterionId?: string; active?: boolean }[]) lines.push(`### ${question.id}\n\n${question.message.replaceAll('<!--', '&lt;!--')}\n\n${question.active === false ? 'Earlier question, retained for context' : question.blocking ? 'Blocks execution' : 'Nonblocking'}${question.criterionId ? ' · Criterion: ' + question.criterionId : ''}. Answer in the Answers section using this ID.`);
    if (metadata.result) lines.push(`Review: [${['review', 'done', 'completed'].includes(status) ? 'Open result' : 'Earlier result'}](${encodeURI(String(metadata.result))})`);
    if (Array.isArray(metadata.commandReceipts)) for (const receipt of metadata.commandReceipts as { commandId: string; outcome?: string; message?: string }[]) lines.push(`Command ${receipt.commandId}: ${receipt.outcome ?? 'pending'}${receipt.message ? ' — ' + receipt.message.replaceAll('<!--', '&lt;!--') : ''}`);
    lines.push(managedEnd);
    parsed.body = replaceManagedBody(parsed.body, lines.join('\n\n'));
  } else { parsed.document.set('status', status); parsed.document.set('werk', metadata); }
  const newline = parsed.raw.includes('\r\n') ? '\r\n' : '\n';
  return '---' + newline + parsed.document.toString({ lineWidth: 0 }).replace(/\r?\n/g, newline) + '---' + newline + parsed.body;
}

export const deliveryFeatureTemplate = `---
schema: worker.request/v1
id: FR-0001
title: Describe the feature
intent: draft
mode: patch
paths: [src/]
priority: normal
quality_profile: feature
depends_on: []
---
# Describe the feature

## Outcome

Describe the desired result and who needs it.

## Scope

Describe the included changes.

## Acceptance criteria

- AC-01: Describe an observable result.

## Boundaries

Describe constraints and excluded changes.

## References

Link relevant project documents.

## Answers

Answer worker questions here using their IDs.

<!-- worker:begin -->
## Worker

Status: Draft
<!-- worker:end -->
`;
