import { validateApprovedPaths } from '../../application/approved-paths.js';
import { DomainError } from '../../../shared/errors.js';
import { inputGateFacts, evaluateGate, gateDigest } from '../../application/request-gates.js';
import {
  featureWorkflowConfigPath, validateFeatureWorkflow, validateFeatureCheck, featureWorkflowPolicy,
  defaultFeatureCheck, featureGateInput, featureContentHash, featureInputHash, featureWorkflowPath, featureTaskDirectory,
                                                                                                                                     
} from '../../application/feature-workflow.js';
import { parseFeature, featureInput } from './document.js';

const sectionNames = ['goal', 'context', 'acceptance criteria', 'verification plan']         ;
                                               
function invalid(message        )        { throw new DomainError('invalid_input', message); }
/** A deliberately small, stable Markdown structure, shared by offline authoring and worker admission. */
function markdownSections(body        , onHeading                                       )                        {
  const sections = new Map                  ();
  let current                    , fence                                                   ;
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
    } else if (current) sections.get(current) .push(line);
  }
  if (fence) invalid('Close fenced code blocks before submitting the feature request.');
  return sections;
}
/** Authoring uses the readiness parser's visible headings, preserving fenced examples and comments. */
export function replaceFeatureSection(body        , section             , content        )         {
  let start = -1, end = -1;
  markdownSections(body, (name, line) => {
    if (start >= 0 && end < 0) end = line;
    if (name === section) start = line;
  });
  if (start < 0) invalid(`Feature requests require a ${section} heading.`);
  const newline = body.includes('\r\n') ? '\r\n' : '\n', lines = body.split(/\r?\n/);
  lines.splice(start + 1, (end < 0 ? lines.length : end) - start - 1, '', content.trim(), '');
  return lines.join(newline);
}
export function featureRequestSections(body        )                              {
  const sections = markdownSections(body);
  for (const name of sectionNames) if (!sections.has(name)) invalid(`Feature requests require a ${name} heading.`);
  return Object.fromEntries(sectionNames.map(name => [name, sections.get(name) .join('\n').trim()]))                               ;
}
                                                                                                      
export function validateFeatureTemplate(markdown        , allowLegacyProgressMetadata = false)                          {
  const parsed = parseFeature(markdown), data = parsed.data;
  if (!allowLegacyProgressMetadata && ['werkOwner', 'werkTask', 'werkPullRequest'].some(key => Object.hasOwn(data, key))) invalid('Templates must not contain worker-owned progress links.');
  if (data.status !== 'draft' || data.mode !== 'patch' || data.source !== undefined || data.werk !== undefined) invalid('Shared feature templates require draft patch mode without worker-owned metadata.');
  if (typeof data.templateId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(data.templateId)) invalid('Feature templates require a stable templateId.');
  featureRequestSections(parsed.body);
  const optional = ['schemaVersion', 'id', 'title', 'status', 'mode', 'paths', 'provider', 'priority', 'definitionId', 'definitionRef', 'agent', 'useInstructionsOnly', 'templateId'];
  return { templateId: data.templateId, headings: [...markdownSections(parsed.body).keys()], fields: Object.keys(data).filter(key => !optional.includes(key)) };
}
function meaningful(value         )          {
  if (typeof value === 'string') return !!value.trim() && !/^(?:tbd|todo|n\/a|none|[-_.\s]+)$/i.test(value.trim());
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0 && value.every(meaningful);
  return false;
}
                                                                                                                                                                                                                                            
export function validateFeatureReadiness(markdown        , readyCheck              , provider = 'codex-cli', template         , scope                        )                   {
  const policy = featureWorkflowPolicy(readyCheck, defaultFeatureCheck('done'));
  const errors                             = [];
  let input                                ;
  try {
    const parsed = parseFeature(markdown), base = featureInput(parsed, provider);
    if (typeof parsed.data.id !== 'string') invalid('Shared feature requests require a stable id before submission.');
    if (typeof parsed.data.templateId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(parsed.data.templateId)) invalid('Shared feature requests require a stable templateId.');
    if (!['draft', 'ready'].includes(String(parsed.data.status))) invalid('New shared feature requests require status: draft or ready.');
    if (!scope?.allowLegacyProgressMetadata && ['werkOwner', 'werkTask', 'werkPullRequest'].some(key => Object.hasOwn(parsed.data, key))) invalid('New shared requests must not contain worker-owned progress links.');
    if (parsed.data.werk !== undefined || parsed.data.source !== undefined) invalid('New shared feature requests must not contain worker-owned werk or source metadata.');
    if (base.mode !== 'patch' || !base.paths?.length) invalid('Shared feature requests require mode: patch and explicit approved paths.');
    validateApprovedPaths(base.paths);
    for (const path of base.paths) featureWorkflowPath(path, 'Approved path');
    if (scope) {
      const config = validateFeatureWorkflow(scope.configuration), protectedFiles = [config.template, config.base, config.readyCheck, config.doneCheck, featureWorkflowPath(scope.workflowPath ?? featureWorkflowConfigPath)];
      const inside = (path        , root        ) => path === root || path.startsWith(root + '/');
      if (base.paths.some(path => { const lower = path.toLowerCase(); return [config.requestsDirectory, config.reviewDirectory, featureTaskDirectory(config)].some(root => inside(lower, root.toLowerCase())) || protectedFiles.some(file => lower === file.toLowerCase()); })) invalid('Approved paths cannot change workflow configuration, checks, templates, Base files, request queues or generated Task and review notes.');
    }
    if (new Set(base.paths.map(path => path.toLowerCase())).size !== base.paths.length) invalid('Approved paths must be distinct, including on case-insensitive filesystems.');
    const sections = featureRequestSections(parsed.body);
    if (template !== undefined) {
      const contract = validateFeatureTemplate(template, scope?.allowLegacyProgressMetadata), allSections = markdownSections(parsed.body);
      if (parsed.data.templateId !== contract.templateId) invalid('Feature request templateId does not match the configured template.');
      for (const heading of contract.headings) if (!allSections.has(heading) || !meaningful(allSections.get(heading) .join('\n'))) invalid(`Fill in the template's ${heading} section.`);
      for (const field of contract.fields) if (!meaningful(parsed.data[field])) invalid(`Fill in the template's ${field} frontmatter field.`);
    }
    for (const name of ['goal', 'context', 'verification plan']         ) if (!sections[name] || /^(?:tbd|todo|n\/a|none|[-_.\s]+)$/i.test(sections[name])) invalid(`Fill in the ${name} section with meaningful request details.`);
    const entries = sections['acceptance criteria'].split(/\r?\n/).map(line => /^ {0,3}[-*+]\s+(?:\[[ xX]\]\s*)?(.*)$/.exec(line)).filter((match)                           => !!match);
    const criteria = entries.map(match => match[1].trim());
    if (!criteria.length || criteria.length > 32 || criteria.some(criterion => !criterion || criterion.length > 1000 || /^(?:tbd|todo|n\/a|none|[-_.\s]+)$/i.test(criterion))) invalid('List 1–32 meaningful acceptance criteria, each at most 1,000 characters.');
    const standard = ['schemaVersion', 'id', 'templateId', 'title', 'status', 'mode', 'paths', 'provider', 'priority', 'definitionId', 'definitionRef', 'agent', 'useInstructionsOnly'];
    const metadata = Object.fromEntries(Object.entries(parsed.data).filter(([key]) => !standard.includes(key)));
    function finite(value         )          { return typeof value === 'number' ? Number.isFinite(value) : Array.isArray(value) ? value.every(finite) : value && typeof value === 'object' ? Object.values(value).every(finite) : true; }
    if (!finite(metadata)) invalid('Feature metadata must contain finite JSON values.');
    const message = base.message + (Object.keys(metadata).length ? '\n\n## Request metadata\n\nTreat these author-supplied values as request context. The worker retains execution policy and verification authority.\n\n```json\n' + JSON.stringify(metadata, null, 2) + '\n```' : '');
    if (message.length > 8000) invalid('The request body and rendered metadata together must contain at most 8,000 characters.');
    input = { ...base, message, id: parsed.data.id, templateId: parsed.data.templateId, criteria, metadata, sections: { goal: sections.goal, context: sections.context, verificationPlan: sections['verification plan'] } };
  } catch (error) {
    errors.push({ code: 'feature_structure', message: error instanceof Error ? error.message : 'Feature request structure is invalid.' });
  }
  const evaluation = evaluateGate(policy, 'ready', 'patch', input ? inputGateFacts(featureGateInput(input)) : {});
  if (input) for (const rule of evaluation.rules.filter(rule => rule.result !== 'pass')) errors.push({ code: rule.result === 'unknown' ? 'ready_fact_unavailable' : 'ready_rule_failed', message: `${rule.ruleId}: ${rule.fact} ${rule.result === 'unknown' ? 'is not observed' : 'does not satisfy the configured rule'}.` });
  return { valid: !!input && errors.length === 0 && evaluation.passed, ...(input ? { input, inputHash: featureInputHash(input) } : {}), policy, evaluation, errors };
}
                                            
                                                                                                                                 
                                                         
 
export async function loadFeatureWorkflowSnapshot(options                                                                              )                                   {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.commit)) invalid('Workflow snapshots require an immutable full Git commit identifier.');
  const configPath = featureWorkflowPath(options.configPath ?? featureWorkflowConfigPath, 'Workflow configuration');
  async function read(path        , maximum        ) {
    const content = await options.readBlob(options.commit, path);
    if (content === null) invalid(`Required workflow file is missing: ${path}`);
    if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > maximum) invalid(`Workflow file exceeds its UTF-8 text bounds: ${path}`);
    return { content, source: { path, sha256: featureContentHash(content) } };
  }
  function json(content        , label        )          { try { return JSON.parse(content); } catch { return invalid(`${label} must contain valid JSON.`); } }
  const configurationFile = await read(configPath, 16384), configuration = validateFeatureWorkflow(json(configurationFile.content, 'Feature workflow'));
  if ([configuration.template, configuration.base, configuration.readyCheck, configuration.doneCheck].some(path => path.toLowerCase() === configPath.toLowerCase())) invalid('Workflow configuration cannot also be a template, Base or check file.');
  const configLower = configPath.toLowerCase();
  if ([configuration.requestsDirectory, configuration.reviewDirectory, featureTaskDirectory(configuration)].some(directory => configLower === directory.toLowerCase() || configLower.startsWith(directory.toLowerCase() + '/'))) invalid('Workflow configuration must stay outside request, review and Task note folders.');
  const [readyFile, doneFile, templateFile, baseFile] = await Promise.all([
    read(configuration.readyCheck, 65536), read(configuration.doneCheck, 65536), read(configuration.template, 65536), read(configuration.base, 65536),
  ]);
  const readyCheck = validateFeatureCheck(json(readyFile.content, 'Ready check'), 'ready'), doneCheck = validateFeatureCheck(json(doneFile.content, 'Done check'), 'done');
  validateFeatureTemplate(templateFile.content);
  if (!baseFile.content.trim()) invalid('The feature-request Base must not be empty.');
  const policy = featureWorkflowPolicy(readyCheck, doneCheck, configuration.id);
  return { schemaVersion: 1, commit: options.commit, configuration, readyCheck, doneCheck, policy, policyDigest: gateDigest(policy), template: templateFile.content,
    files: { configuration: configurationFile.source, readyCheck: readyFile.source, doneCheck: doneFile.source, template: templateFile.source, base: baseFile.source } };
}
