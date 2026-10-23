import { validateApprovedPaths } from '../../application/approved-paths.js';
import { DomainError } from '../../../shared/errors.js';
import { inputGateFacts, evaluateGate, gateDigest } from '../../application/request-gates.js';
import {
  featureWorkflowConfigPath, validateFeatureWorkflow, validateFeatureCheck, featureWorkflowPolicy, validateFeatureReadyReview, validateFeatureDefinitionPrompts,
  defaultFeatureCheck, featureGateInput, featureContentHash, featureInputHash, featureWorkflowPath, featureTaskDirectory,
  type FeatureCheck, type FeatureReadiness, type FeatureWorkflowSnapshot, type SharedFeatureInput, type FeatureWorkflowConfiguration,
} from '../../application/feature-workflow.js';
import { parseFeature, featureInput, featureRequestContext } from './document.js';

const sectionNames = ['goal', 'context', 'acceptance criteria', 'verification plan'] as const;
type SectionName = typeof sectionNames[number];
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
/** A deliberately small, stable Markdown structure, shared by offline authoring and worker admission. */
export function featureMarkdownSections(body: string, onHeading?: (name: string, line: number) => void): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string | undefined, fence: { character: string; length: number } | undefined;
  const visible = body.replace(/<!--[\s\S]*?-->/g, comment => comment.replace(/[^\r\n]/g, ''));
  for (const [index, line] of visible.split(/\r?\n/).entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
      continue;
    }
    if (marker) { fence = { character: marker[1][0], length: marker[1].length }; continue; }
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const name = heading[1].trim().toLowerCase();
      onHeading?.(name, index);
      current = name;
      if (sections.has(current)) invalid(`Use exactly one ${current} section.`);
      sections.set(current, []);
    } else if (current) sections.get(current)!.push(line);
  }
  if (fence) invalid('Close fenced code blocks before submitting the feature request.');
  return sections;
}
/** Authoring uses the readiness parser's visible headings, preserving fenced examples and comments. */
export function replaceFeatureSection(body: string, section: SectionName, content: string): string {
  let start = -1, end = -1;
  featureMarkdownSections(body, (name, line) => {
    if (start >= 0 && end < 0) end = line;
    if (name === section) start = line;
  });
  if (start < 0) invalid(`Feature requests require a ${section} heading.`);
  const newline = body.includes('\r\n') ? '\r\n' : '\n', lines = body.split(/\r?\n/);
  lines.splice(start + 1, (end < 0 ? lines.length : end) - start - 1, '', content.trim(), '');
  return lines.join(newline);
}
export function featureRequestSections(body: string): Record<SectionName, string> {
  const sections = featureMarkdownSections(body);
  for (const name of sectionNames) if (!sections.has(name)) invalid(`Feature requests require a ${name} heading.`);
  return Object.fromEntries(sectionNames.map(name => [name, sections.get(name)!.join('\n').trim()])) as Record<SectionName, string>;
}
export interface FeatureTemplateContract { templateId: string; headings: string[]; fields: string[]; }
export function validateFeatureTemplate(markdown: string, allowLegacyProgressMetadata = false): FeatureTemplateContract {
  const parsed = parseFeature(markdown), data = parsed.data;
  if (!allowLegacyProgressMetadata && ['werkOwner', 'werkTask', 'werkPullRequest'].some(key => Object.hasOwn(data, key))) invalid('Templates must not contain worker-owned progress links.');
  if (data.status !== 'draft' || data.mode !== 'patch' || data.source !== undefined || data.werk !== undefined) invalid('Shared feature templates require draft patch mode without worker-owned metadata.');
  if (typeof data.templateId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(data.templateId)) invalid('Feature templates require a stable templateId.');
  featureRequestSections(parsed.body);
  const optional = ['schemaVersion', 'id', 'title', 'status', 'mode', 'paths', 'provider', 'model', 'effort', 'execution_profile', 'priority', 'definitionId', 'definitionRef', 'agent', 'useInstructionsOnly', 'templateId'];
  return { templateId: data.templateId, headings: [...featureMarkdownSections(parsed.body).keys()], fields: Object.keys(data).filter(key => !optional.includes(key)) };
}
function meaningful(value: unknown): boolean {
  if (typeof value === 'string') return !!value.trim() && !/^(?:tbd|todo|n\/a|none|[-_.\s]+)$/i.test(value.trim());
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0 && value.every(meaningful);
  return false;
}
export interface FeatureReadinessScope { configuration: FeatureWorkflowConfiguration; workflowPath?: string; /** Private recovery only: old accepted metadata predates generated progress links. */ allowLegacyProgressMetadata?: boolean; }
export function validateFeatureWorkflowApprovedPaths(paths: string[], configuration: FeatureWorkflowConfiguration, workflowPath = featureWorkflowConfigPath): void {
  const config = validateFeatureWorkflow(configuration), protectedFiles = [config.template, config.base, config.readyCheck, config.doneCheck, config.readyPrompt, config.donePrompt, config.readyReviewPrompt, featureWorkflowPath(workflowPath)].filter((path): path is string => path !== undefined);
  const inside = (path: string, root: string) => path === root || path.startsWith(root + '/');
  // A folder approval (ending in /) is refused when it contains, or lies within, protected workflow storage.
  const touches = (path: string, protectedPath: string) => path.endsWith('/') ? inside(protectedPath, path.slice(0, -1)) || inside(path.slice(0, -1), protectedPath) : inside(path, protectedPath);
  if (paths.some(path => { const lower = path.toLowerCase(); return [config.requestsDirectory, config.reviewDirectory, featureTaskDirectory(config)].some(root => touches(lower, root.toLowerCase())) || protectedFiles.some(file => lower.endsWith('/') ? inside(file.toLowerCase(), lower.slice(0, -1)) : lower === file.toLowerCase()); })) invalid('Approved paths cannot change workflow configuration, checks, definition prompts, templates, Base files, request queues or generated Task and review notes.');
}
export function validateFeatureReadiness(markdown: string, readyCheck: FeatureCheck, provider = 'codex-cli', template?: string, scope?: FeatureReadinessScope): FeatureReadiness {
  const policy = featureWorkflowPolicy(readyCheck, defaultFeatureCheck('done'));
  const errors: FeatureReadiness['errors'] = [];
  let input: SharedFeatureInput | undefined;
  try {
    const parsed = parseFeature(markdown), base = featureInput(parsed, provider);
    if (typeof parsed.data.id !== 'string') invalid('Shared feature requests require a stable id before submission.');
    if (typeof parsed.data.templateId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(parsed.data.templateId)) invalid('Shared feature requests require a stable templateId.');
    if (!['draft', 'ready'].includes(String(parsed.data.status))) invalid('New shared feature requests require status: draft or ready.');
    if (!scope?.allowLegacyProgressMetadata && ['werkOwner', 'werkTask', 'werkPullRequest'].some(key => Object.hasOwn(parsed.data, key))) invalid('New shared requests must not contain worker-owned progress links.');
    if (parsed.data.werk !== undefined || parsed.data.source !== undefined) invalid('New shared feature requests must not contain worker-owned werk or source metadata.');
    if (base.mode !== 'patch' || !base.paths?.length) invalid('Shared feature requests require mode: patch and explicit approved paths.');
    validateApprovedPaths(base.paths, 'Approved paths', { folders: true });
    for (const path of base.paths) featureWorkflowPath(path.endsWith('/') ? path.slice(0, -1) : path, 'Approved path');
    if (scope) validateFeatureWorkflowApprovedPaths(base.paths, scope.configuration, scope.workflowPath);
    if (new Set(base.paths.map(path => path.toLowerCase())).size !== base.paths.length) invalid('Approved paths must be distinct, including on case-insensitive filesystems.');
    const sections = featureRequestSections(parsed.body);
    if (template !== undefined) {
      const contract = validateFeatureTemplate(template, scope?.allowLegacyProgressMetadata), allSections = featureMarkdownSections(parsed.body);
      if (parsed.data.templateId !== contract.templateId) invalid('Feature request templateId does not match the configured template.');
      for (const heading of contract.headings) if (!allSections.has(heading) || !meaningful(allSections.get(heading)!.join('\n'))) invalid(`Fill in the template's ${heading} section.`);
      for (const field of contract.fields) if (!meaningful(parsed.data[field])) invalid(`Fill in the template's ${field} frontmatter field.`);
    }
    for (const name of ['goal', 'context', 'verification plan'] as const) if (!sections[name] || /^(?:tbd|todo|n\/a|none|[-_.\s]+)$/i.test(sections[name])) invalid(`Fill in the ${name} section with meaningful request details.`);
    const entries = sections['acceptance criteria'].split(/\r?\n/).map(line => /^ {0,3}[-*+]\s+(?:\[[ xX]\]\s*)?(.*)$/.exec(line)).filter((match): match is RegExpExecArray => !!match);
    const criteria = entries.map(match => match[1].trim());
    if (!criteria.length || criteria.length > 32 || criteria.some(criterion => !criterion || criterion.length > 1000 || /^(?:tbd|todo|n\/a|none|[-_.\s]+)$/i.test(criterion))) invalid('List 1–32 meaningful acceptance criteria, each at most 1,000 characters.');
    const { message, metadata } = featureRequestContext(parsed.data, base);
    input = { ...base, message, id: parsed.data.id, templateId: parsed.data.templateId, criteria, metadata, sections: { goal: sections.goal, context: sections.context, verificationPlan: sections['verification plan'] } };
  } catch (error) {
    errors.push({ code: 'feature_structure', message: error instanceof Error ? error.message : 'Feature request structure is invalid.' });
  }
  const evaluation = evaluateGate(policy, 'ready', 'patch', input ? inputGateFacts(featureGateInput(input)) : {});
  if (input) for (const rule of evaluation.rules.filter(rule => rule.result !== 'pass')) errors.push({ code: rule.result === 'unknown' ? 'ready_fact_unavailable' : 'ready_rule_failed', message: `${rule.ruleId}: ${rule.fact} ${rule.result === 'unknown' ? 'is not observed' : 'does not satisfy the configured rule'}.` });
  return { valid: !!input && errors.length === 0 && evaluation.passed, ...(input ? { input, inputHash: featureInputHash(input) } : {}), policy, evaluation, errors };
}
export interface FeatureWorkflowBlobReader {
  /** Return an ordinary UTF-8 Git blob at this exact immutable commit; missing files return null. Refuse symlinks/submodules. */
  (commit: string, path: string): Promise<string | null>;
}
export async function loadFeatureWorkflowSnapshot(options: { commit: string; readBlob: FeatureWorkflowBlobReader; configPath?: string }): Promise<FeatureWorkflowSnapshot> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.commit)) invalid('Workflow snapshots require an immutable full Git commit identifier.');
  const configPath = featureWorkflowPath(options.configPath ?? featureWorkflowConfigPath, 'Workflow configuration');
  async function read(path: string, maximum: number) {
    const content = await options.readBlob(options.commit, path);
    if (content === null) invalid(`Required workflow file is missing: ${path}`);
    if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > maximum) invalid(`Workflow file exceeds its UTF-8 text bounds: ${path}`);
    return { content, source: { path, sha256: featureContentHash(content) } };
  }
  function json(content: string, label: string): unknown { try { return JSON.parse(content); } catch { return invalid(`${label} must contain valid JSON.`); } }
  const configurationFile = await read(configPath, 16384), configuration = validateFeatureWorkflow(json(configurationFile.content, 'Feature workflow'));
  if ([configuration.template, configuration.base, configuration.readyCheck, configuration.doneCheck, configuration.readyPrompt, configuration.donePrompt, configuration.readyReviewPrompt].some(path => path?.toLowerCase() === configPath.toLowerCase())) invalid('Workflow configuration cannot also be a template, Base, check or definition prompt file.');
  const configLower = configPath.toLowerCase();
  if ([configuration.requestsDirectory, configuration.reviewDirectory, featureTaskDirectory(configuration)].some(directory => configLower === directory.toLowerCase() || configLower.startsWith(directory.toLowerCase() + '/'))) invalid('Workflow configuration must stay outside request, review and Task note folders.');
  const [readyFile, doneFile, templateFile, baseFile, readyPromptFile, donePromptFile, readyReviewFile] = await Promise.all([
    read(configuration.readyCheck, 65536), read(configuration.doneCheck, 65536), read(configuration.template, 65536), read(configuration.base, 65536),
    configuration.readyPrompt ? read(configuration.readyPrompt, 65536) : undefined,
    configuration.donePrompt ? read(configuration.donePrompt, 65536) : undefined,
    configuration.readyReviewPrompt ? read(configuration.readyReviewPrompt, 65536) : undefined,
  ]);
  const readyCheck = validateFeatureCheck(json(readyFile.content, 'Ready check'), 'ready'), doneCheck = validateFeatureCheck(json(doneFile.content, 'Done check'), 'done');
  validateFeatureTemplate(templateFile.content);
  if (!baseFile.content.trim()) invalid('The feature-request Base must not be empty.');
  const policy = featureWorkflowPolicy(readyCheck, doneCheck, configuration.id);
  const definitionPrompts = readyPromptFile || donePromptFile ? validateFeatureDefinitionPrompts({
    schemaVersion: 1, commit: options.commit,
    ...(readyPromptFile ? { ready: { ...readyPromptFile.source, content: readyPromptFile.content } } : {}),
    ...(donePromptFile ? { done: { ...donePromptFile.source, content: donePromptFile.content } } : {}),
  }) : undefined;
  const readyReview = readyReviewFile ? validateFeatureReadyReview({ schemaVersion: 1, commit: options.commit, prompt: { ...readyReviewFile.source, content: readyReviewFile.content } }) : undefined;
  return { schemaVersion: 1, commit: options.commit, configuration, readyCheck, doneCheck, policy, policyDigest: gateDigest(policy), template: templateFile.content,
    ...(definitionPrompts ? { definitionPrompts } : {}),
    ...(readyReview ? { readyReview } : {}),
    files: { configuration: configurationFile.source, readyCheck: readyFile.source, doneCheck: doneFile.source, template: templateFile.source, base: baseFile.source,
      ...(readyPromptFile ? { readyPrompt: readyPromptFile.source } : {}), ...(donePromptFile ? { donePrompt: donePromptFile.source } : {}),
      ...(readyReviewFile ? { readyReviewPrompt: readyReviewFile.source } : {}),
    } };
}

/** Recovery binds frozen prompt bytes to the accepted workflow and its source descriptors. */
export function assertFeatureWorkflowDefinitionPrompts(snapshot: FeatureWorkflowSnapshot): void {
  const reviewPath = snapshot.configuration.readyReviewPrompt, reviewSource = snapshot.files.readyReviewPrompt;
  if (reviewPath === undefined) {
    if (snapshot.readyReview !== undefined || reviewSource !== undefined) invalid('Unexpected frozen Ready Check prompt or source descriptor.');
  } else {
    const review = validateFeatureReadyReview(snapshot.readyReview);
    if (review.commit !== snapshot.commit || review.prompt.path !== reviewPath || !reviewSource || Object.keys(reviewSource).length !== 2 || reviewSource.path !== reviewPath || reviewSource.sha256 !== review.prompt.sha256) invalid('Frozen Ready Check prompt content and source descriptor must match the configured path and commit.');
  }
  const configured = snapshot.configuration.readyPrompt !== undefined || snapshot.configuration.donePrompt !== undefined;
  if (configured !== (snapshot.definitionPrompts !== undefined)) invalid('Frozen definition prompts do not match the configured workflow.');
  const prompts = snapshot.definitionPrompts === undefined ? undefined : validateFeatureDefinitionPrompts(snapshot.definitionPrompts);
  if (prompts && prompts.commit !== snapshot.commit) invalid('Frozen definition prompts belong to a different source commit.');
  for (const stage of ['ready', 'done'] as const) {
    const key = stage === 'ready' ? 'readyPrompt' : 'donePrompt';
    const path = snapshot.configuration[key], prompt = prompts?.[stage], source = snapshot.files[key];
    if (path === undefined) {
      if (prompt !== undefined || source !== undefined) invalid('Unexpected frozen definition prompt or source descriptor.');
    } else if (!prompt || prompt.path !== path || !source || Object.keys(source).length !== 2 || source.path !== path || source.sha256 !== prompt.sha256) {
      invalid('Frozen definition prompt content and source descriptor must match the configured path.');
    }
  }
}
