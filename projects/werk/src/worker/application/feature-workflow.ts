import { createHash } from 'node:crypto';
import { DomainError } from '../../shared/errors.js';
import { defaultGatePolicy, evaluateGate, gateDigest, validateGatePolicy, type GateFactSnapshot, type GateInput, type GatePolicy, type GateRule, type GateStage } from './request-gates.js';
import type { FeatureInput } from './feature-requests.js';

export const featureWorkflowConfigPath = '.werk/feature-workflow.json';
export interface FeatureWorkflowConfiguration {
  schemaVersion: 1; id: string; requestsDirectory: string; reviewDirectory: string;
  template: string; base: string; readyCheck: string; doneCheck: string;
  /** Optional team instructions appended to model dispatch; JSON gates remain authoritative. */
  readyPrompt?: string; donePrompt?: string;
  /** Optional reviewer instructions before implementation readiness; omission disables this review. */
  readyReviewPrompt?: string;
  /** Older frozen workflows keep Task notes beneath their review directory. */
  tasksDirectory?: string;
}
export interface FeatureCheck {
  schemaVersion: 1; id: string; version: number; stage: GateStage;
  rules: { chat: GateRule[]; patch: GateRule[] };
}
export interface SharedFeatureInput extends FeatureInput {
  id: string; templateId: string; criteria: string[]; metadata: Record<string, unknown>;
  sections: { goal: string; context: string; verificationPlan: string };
}
export interface FeatureSourceFile { path: string; sha256: string; }
export interface FeatureDefinitionPrompt extends FeatureSourceFile { content: string; }
export interface FeatureDefinitionPrompts {
  schemaVersion: 1; commit: string; ready?: FeatureDefinitionPrompt; done?: FeatureDefinitionPrompt;
}
export interface FeatureReadyReview {
  schemaVersion: 1; commit: string; prompt: FeatureDefinitionPrompt;
}
export interface FeatureWorkflowSnapshot {
  schemaVersion: 1; commit: string; configuration: FeatureWorkflowConfiguration;
  readyCheck: FeatureCheck; doneCheck: FeatureCheck; policy: GatePolicy; policyDigest: string;
  template: string;
  definitionPrompts?: FeatureDefinitionPrompts;
  readyReview?: FeatureReadyReview;
  files: { configuration: FeatureSourceFile; readyCheck: FeatureSourceFile; doneCheck: FeatureSourceFile; template: FeatureSourceFile; base: FeatureSourceFile; readyPrompt?: FeatureSourceFile; donePrompt?: FeatureSourceFile; readyReviewPrompt?: FeatureSourceFile };
}
export interface FeatureReadiness {
  valid: boolean; input?: SharedFeatureInput; inputHash?: string;
  policy: GatePolicy; evaluation: ReturnType<typeof evaluateGate>;
  errors: { code: string; message: string }[];
}
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid(`Invalid ${label} fields.`);
  return value as Record<string, unknown>;
}
export function featureWorkflowPath(value: unknown, label = 'Workflow path'): string {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\\\x00-\x1f\x7f:*?"<>|]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || ['.git', 'node_modules'].includes(part.toLowerCase()))) invalid(`${label} must be a safe repository-relative POSIX path.`);
  return value;
}
const inside = (path: string, directory: string) => path.toLowerCase() === directory.toLowerCase() || path.toLowerCase().startsWith(directory.toLowerCase() + '/');
export function defaultFeatureWorkflow(): FeatureWorkflowConfiguration {
  return { schemaVersion: 1, id: 'feature-requests', requestsDirectory: 'features', reviewDirectory: 'feature-reviews', tasksDirectory: 'feature-tasks', template: 'features/_templates/feature-request.md', base: 'Feature Requests.base', readyCheck: 'fr-ready-check.json', doneCheck: 'fr-done-check.json' };
}
export function featureTaskDirectory(config: FeatureWorkflowConfiguration): string {
  return config.tasksDirectory ?? config.reviewDirectory + '/_tasks';
}
export function validateFeatureWorkflow(value: unknown): FeatureWorkflowConfiguration {
  const raw = exact(value, ['schemaVersion', 'id', 'requestsDirectory', 'reviewDirectory', 'tasksDirectory', 'template', 'base', 'readyCheck', 'doneCheck', 'readyPrompt', 'donePrompt', 'readyReviewPrompt'], 'feature workflow');
  if (raw.schemaVersion !== 1 || typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(raw.id)) invalid('Feature workflow requires schemaVersion 1 and a stable lowercase ID.');
  const result = { schemaVersion: 1, id: raw.id } as FeatureWorkflowConfiguration;
  for (const key of ['requestsDirectory', 'reviewDirectory', 'template', 'base', 'readyCheck', 'doneCheck'] as const) result[key] = featureWorkflowPath(raw[key], key);
  for (const key of ['readyPrompt', 'donePrompt', 'readyReviewPrompt'] as const) if (raw[key] !== undefined) result[key] = featurePromptPath(raw[key], key);
  if (raw.tasksDirectory !== undefined) result.tasksDirectory = featureWorkflowPath(raw.tasksDirectory, 'tasksDirectory');
  const tasks = featureTaskDirectory(result);
  if (inside(tasks, result.requestsDirectory) || inside(result.requestsDirectory, tasks) || inside(result.reviewDirectory, tasks) || inside(tasks, result.reviewDirectory + '/_operations')) invalid('Task notes must be separate from requests, review roots and publication receipts. A review subfolder is allowed.');
  if (inside(result.requestsDirectory, result.reviewDirectory) || inside(result.reviewDirectory, result.requestsDirectory)) invalid('Request and review directories must be separate, non-overlapping folders.');
  if ([result.requestsDirectory, result.reviewDirectory, tasks].some(path => path.toLowerCase().split('/').includes('.werk'))) invalid('Request and review directories must be outside private .werk storage.');
  if (!result.template.endsWith('.md') || !result.base.endsWith('.base') || !result.readyCheck.endsWith('.json') || !result.doneCheck.endsWith('.json')) invalid('Workflow template, Base and checks require .md, .base and .json extensions.');
  const prompts = [result.readyPrompt, result.donePrompt, result.readyReviewPrompt].filter((path): path is string => path !== undefined);
  const files = [result.template, result.base, result.readyCheck, result.doneCheck, ...prompts];
  if ([result.requestsDirectory, result.reviewDirectory, tasks, ...files].some(path => ['.agents', '.claude', '.codex', '.werk/authoring', '.werk/worker', '.werk/provider-home', 'bin/apps'].some(reserved => inside(path, reserved) || inside(reserved, path)))) invalid('Workflow paths cannot overlap private runtime, installed applications or agent integration files.');
  if (new Set(files.map(path => path.toLowerCase())).size !== files.length || files.some(path => [result.requestsDirectory, result.reviewDirectory, tasks].some(directory => path.toLowerCase() === directory.toLowerCase()))) invalid('Workflow files must use distinct paths outside folder roots.');
  if (files.some(path => inside(path, result.reviewDirectory) || inside(path, tasks))) invalid('Workflow configuration files cannot be generated review notes.');
  if (inside(result.template, result.requestsDirectory) && result.template.slice(result.requestsDirectory.length + 1).split('/').length === 1 && !result.template.slice(result.requestsDirectory.length + 1).startsWith('_')) invalid('Place the template in a subfolder or use an underscore-prefixed name to keep it out of intake.');
  if (prompts.some(path => path.endsWith('.md') && inside(path, result.requestsDirectory) && path.slice(result.requestsDirectory.length + 1).split('/').length === 1 && !path.slice(result.requestsDirectory.length + 1).startsWith('_'))) invalid('Place Markdown definition prompts in a subfolder or use an underscore-prefixed name to keep them out of intake.');
  return result;
}
function featurePromptPath(value: unknown, label: string): string {
  const path = featureWorkflowPath(value, label);
  if (!/\.(?:md|txt)$/.test(path)) invalid(`${label} must name a .md or .txt prompt file.`);
  return path;
}
export function validateFeaturePromptContent(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 65536 || Buffer.from(value, 'utf8').toString('utf8') !== value) invalid(`Definition prompt must contain nonempty UTF-8 text of at most 64 KiB without NUL bytes: ${path}`);
  return value;
}
/** Validates immutable model context without interpreting it as gate evidence or permission. */
export function validateFeatureDefinitionPrompts(value: unknown): FeatureDefinitionPrompts {
  const raw = exact(value, ['schemaVersion', 'commit', 'ready', 'done'], 'definition prompts');
  if (raw.schemaVersion !== 1 || typeof raw.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(raw.commit) || raw.ready === undefined && raw.done === undefined) invalid('Definition prompts require schemaVersion 1, an immutable Git commit and at least one prompt.');
  const result: FeatureDefinitionPrompts = { schemaVersion: 1, commit: raw.commit };
  for (const stage of ['ready', 'done'] as const) {
    if (raw[stage] === undefined) continue;
    result[stage] = validatePromptSource(raw[stage], `${stage} definition prompt`);
  }
  if (result.ready && result.done && result.ready.path.toLowerCase() === result.done.path.toLowerCase()) invalid('Definition prompts must use distinct paths.');
  return result;
}
function validatePromptSource(value: unknown, label: string): FeatureDefinitionPrompt {
  const prompt = exact(value, ['path', 'sha256', 'content'], label);
  const path = featurePromptPath(prompt.path, label), content = validateFeaturePromptContent(prompt.content, path);
  if (typeof prompt.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(prompt.sha256) || featureContentHash(content) !== prompt.sha256) invalid(`Definition prompt content does not match its SHA-256: ${path}`);
  return { path, sha256: prompt.sha256, content };
}
/** Reviewer guidance has its own snapshot and is never implicit implementation context. */
export function validateFeatureReadyReview(value: unknown): FeatureReadyReview {
  const raw = exact(value, ['schemaVersion', 'commit', 'prompt'], 'Feature Request Ready Check');
  if (raw.schemaVersion !== 1 || typeof raw.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(raw.commit)) invalid('Feature Request Ready Check requires schemaVersion 1 and an immutable Git commit.');
  return { schemaVersion: 1, commit: raw.commit, prompt: validatePromptSource(raw.prompt, 'Ready Check prompt') };
}
export function defaultFeatureCheck(stage: GateStage): FeatureCheck {
  return { schemaVersion: 1, id: `fr-${stage}-check`, version: 1, stage, rules: { chat: [], patch: [] } };
}
export function validateFeatureCheck(value: unknown, stage: GateStage): FeatureCheck {
  const raw = exact(value, ['schemaVersion', 'id', 'version', 'stage', 'rules'], 'feature check');
  if (raw.schemaVersion !== 1 || raw.stage !== stage) invalid(`Expected a schemaVersion 1 ${stage} feature check.`);
  const policy = defaultGatePolicy();
  policy.id = raw.id as string; policy.version = raw.version as number;
  policy[stage] = raw.rules as FeatureCheck['rules'];
  validateGatePolicy(policy);
  for (const rules of Object.values(policy[stage])) if (rules.some(rule => rule.id.startsWith('werk-required-'))) invalid('Rule IDs beginning werk-required- are reserved for mandatory checks.');
  return structuredClone(raw) as unknown as FeatureCheck;
}
const readyRequired: GateRule[] = [
  { id: 'werk-required-title', fact: 'input.titleLength', op: 'gte', value: 1 },
  { id: 'werk-required-message', fact: 'input.messageLength', op: 'gte', value: 1 },
  { id: 'werk-required-message-bounded', fact: 'input.messageLength', op: 'lte', value: 8000 },
  { id: 'werk-required-criteria', fact: 'input.criteriaCount', op: 'gte', value: 1 },
  { id: 'werk-required-approved-files', fact: 'input.approvedFileCount', op: 'gte', value: 1 },
  { id: 'werk-required-approved-paths', fact: 'input.pathsValid', op: 'eq', value: true },
];
const doneRequired: GateRule[] = [
  { id: 'werk-required-completed', fact: 'execution.outcome', op: 'eq', value: 'completed' },
  { id: 'werk-required-output', fact: 'output.nonEmpty', op: 'eq', value: true },
  { id: 'werk-required-protocol', fact: 'output.protocolValid', op: 'eq', value: true },
  { id: 'werk-required-patch', fact: 'output.patchPresent', op: 'eq', value: true },
  { id: 'werk-required-changed-file', fact: 'output.changedFileCount', op: 'gte', value: 1 },
  { id: 'werk-required-no-input', fact: 'pending.count', op: 'eq', value: 0 },
  { id: 'werk-required-no-blockers', fact: 'findings.blockingCount', op: 'eq', value: 0 },
];
export function featureWorkflowPolicy(ready: FeatureCheck, done: FeatureCheck, id = 'shared-feature-workflow'): GatePolicy {
  const first = validateFeatureCheck(ready, 'ready'), last = validateFeatureCheck(done, 'done');
  // Preserve the existing journal's 32-rule bound after appending mandatory checks.
  if (first.rules.patch.length + readyRequired.length > 32 || last.rules.patch.length + doneRequired.length > 32) invalid('Configured checks exceed the 32-rule limit after mandatory workflow checks.');
  return validateGatePolicy({ schemaVersion: 1, id, version: Math.max(first.version, last.version), ready: { chat: first.rules.chat, patch: [...readyRequired, ...first.rules.patch] }, done: { chat: last.rules.chat, patch: [...doneRequired, ...last.rules.patch] }, reviewer: { enabled: false, provider: 'same', maxAttempts: 1 }, rework: { maxAttempts: 0 } });
}
export function featureGateInput(input: SharedFeatureInput): GateInput {
  return { kind: 'patch', title: input.title, message: input.message, criteria: [...input.criteria], files: input.paths!.map(path => ({ path, bytes: null })) };
}
export function evaluateFeatureDone(policy: GatePolicy, facts: GateFactSnapshot) {
  // Only the coordinator supplies independently recorded facts. A model reply is never evidence for tests/build.
  return evaluateGate(validateGatePolicy(policy), 'done', 'patch', facts);
}
export const featureContentHash = (content: string) => createHash('sha256').update(content).digest('hex');
export const featureInputHash = (input: SharedFeatureInput) => gateDigest(input);
