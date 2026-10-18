import { createHash } from 'node:crypto';
import { DomainError } from '../../shared/errors.js';
import { defaultGatePolicy, evaluateGate, gateDigest, validateGatePolicy,                                                                                       } from './request-gates.js';
                                                          

export const featureWorkflowConfigPath = '.werk/feature-workflow.json';
                                               
                                                                                   
                                                                        
                                                                               
                          
 
                               
                                                                  
                                                 
 
                                                          
                                                                                        
                                                                        
 
                                                                    
                                          
                                                                                
                                                                                              
                   
                                                                                                                                                                 
 
                                   
                                                                 
                                                                  
                                              
 
function invalid(message        )        { throw new DomainError('invalid_input', message); }
function exact(value         , keys                   , label        )                          {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid(`Invalid ${label} fields.`);
  return value                           ;
}
export function featureWorkflowPath(value         , label = 'Workflow path')         {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\\\x00-\x1f\x7f:*?"<>|]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || ['.git', 'node_modules'].includes(part.toLowerCase()))) invalid(`${label} must be a safe repository-relative POSIX path.`);
  return value;
}
const inside = (path        , directory        ) => path.toLowerCase() === directory.toLowerCase() || path.toLowerCase().startsWith(directory.toLowerCase() + '/');
export function defaultFeatureWorkflow()                               {
  return { schemaVersion: 1, id: 'feature-requests', requestsDirectory: 'features', reviewDirectory: 'feature-reviews', tasksDirectory: 'feature-tasks', template: 'features/_templates/feature-request.md', base: 'Feature Requests.base', readyCheck: 'fr-ready-check.json', doneCheck: 'fr-done-check.json' };
}
export function featureTaskDirectory(config                              )         {
  return config.tasksDirectory ?? config.reviewDirectory + '/_tasks';
}
export function validateFeatureWorkflow(value         )                               {
  const raw = exact(value, ['schemaVersion', 'id', 'requestsDirectory', 'reviewDirectory', 'tasksDirectory', 'template', 'base', 'readyCheck', 'doneCheck'], 'feature workflow');
  if (raw.schemaVersion !== 1 || typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(raw.id)) invalid('Feature workflow requires schemaVersion 1 and a stable lowercase ID.');
  const result = { schemaVersion: 1, id: raw.id }                                ;
  for (const key of ['requestsDirectory', 'reviewDirectory', 'template', 'base', 'readyCheck', 'doneCheck']         ) result[key] = featureWorkflowPath(raw[key], key);
  if (raw.tasksDirectory !== undefined) result.tasksDirectory = featureWorkflowPath(raw.tasksDirectory, 'tasksDirectory');
  const tasks = featureTaskDirectory(result);
  if (inside(tasks, result.requestsDirectory) || inside(result.requestsDirectory, tasks) || inside(result.reviewDirectory, tasks) || inside(tasks, result.reviewDirectory + '/_operations')) invalid('Task notes must be separate from requests, review roots and publication receipts. A review subfolder is allowed.');
  if (inside(result.requestsDirectory, result.reviewDirectory) || inside(result.reviewDirectory, result.requestsDirectory)) invalid('Request and review directories must be separate, non-overlapping folders.');
  if ([result.requestsDirectory, result.reviewDirectory, tasks].some(path => path.toLowerCase().split('/').includes('.werk'))) invalid('Request and review directories must be outside private .werk storage.');
  if (!result.template.endsWith('.md') || !result.base.endsWith('.base') || !result.readyCheck.endsWith('.json') || !result.doneCheck.endsWith('.json')) invalid('Workflow template, Base and checks require .md, .base and .json extensions.');
  const files = [result.template, result.base, result.readyCheck, result.doneCheck];
  if ([result.requestsDirectory, result.reviewDirectory, tasks, ...files].some(path => ['.agents', '.claude', '.codex', '.werk/authoring', '.werk/worker', '.werk/provider-home', 'bin/apps'].some(reserved => inside(path, reserved) || inside(reserved, path)))) invalid('Workflow paths cannot overlap private runtime, installed applications or agent integration files.');
  if (new Set(files.map(path => path.toLowerCase())).size !== files.length || files.some(path => [result.requestsDirectory, result.reviewDirectory, tasks].some(directory => path.toLowerCase() === directory.toLowerCase()))) invalid('Workflow files must use distinct paths outside folder roots.');
  if (files.some(path => inside(path, result.reviewDirectory) || inside(path, tasks))) invalid('Workflow configuration files cannot be generated review notes.');
  if (inside(result.template, result.requestsDirectory) && result.template.slice(result.requestsDirectory.length + 1).split('/').length === 1 && !result.template.slice(result.requestsDirectory.length + 1).startsWith('_')) invalid('Place the template in a subfolder or use an underscore-prefixed name to keep it out of intake.');
  return result;
}
export function defaultFeatureCheck(stage           )               {
  return { schemaVersion: 1, id: `fr-${stage}-check`, version: 1, stage, rules: { chat: [], patch: [] } };
}
export function validateFeatureCheck(value         , stage           )               {
  const raw = exact(value, ['schemaVersion', 'id', 'version', 'stage', 'rules'], 'feature check');
  if (raw.schemaVersion !== 1 || raw.stage !== stage) invalid(`Expected a schemaVersion 1 ${stage} feature check.`);
  const policy = defaultGatePolicy();
  policy.id = raw.id          ; policy.version = raw.version          ;
  policy[stage] = raw.rules                         ;
  validateGatePolicy(policy);
  for (const rules of Object.values(policy[stage])) if (rules.some(rule => rule.id.startsWith('werk-required-'))) invalid('Rule IDs beginning werk-required- are reserved for mandatory checks.');
  return structuredClone(raw)                           ;
}
const readyRequired             = [
  { id: 'werk-required-title', fact: 'input.titleLength', op: 'gte', value: 1 },
  { id: 'werk-required-message', fact: 'input.messageLength', op: 'gte', value: 1 },
  { id: 'werk-required-message-bounded', fact: 'input.messageLength', op: 'lte', value: 8000 },
  { id: 'werk-required-criteria', fact: 'input.criteriaCount', op: 'gte', value: 1 },
  { id: 'werk-required-approved-files', fact: 'input.approvedFileCount', op: 'gte', value: 1 },
  { id: 'werk-required-approved-paths', fact: 'input.pathsValid', op: 'eq', value: true },
];
const doneRequired             = [
  { id: 'werk-required-completed', fact: 'execution.outcome', op: 'eq', value: 'completed' },
  { id: 'werk-required-output', fact: 'output.nonEmpty', op: 'eq', value: true },
  { id: 'werk-required-protocol', fact: 'output.protocolValid', op: 'eq', value: true },
  { id: 'werk-required-patch', fact: 'output.patchPresent', op: 'eq', value: true },
  { id: 'werk-required-changed-file', fact: 'output.changedFileCount', op: 'gte', value: 1 },
  { id: 'werk-required-no-input', fact: 'pending.count', op: 'eq', value: 0 },
  { id: 'werk-required-no-blockers', fact: 'findings.blockingCount', op: 'eq', value: 0 },
];
export function featureWorkflowPolicy(ready              , done              , id = 'shared-feature-workflow')             {
  const first = validateFeatureCheck(ready, 'ready'), last = validateFeatureCheck(done, 'done');
  // Preserve the existing journal's 32-rule bound after appending mandatory checks.
  if (first.rules.patch.length + readyRequired.length > 32 || last.rules.patch.length + doneRequired.length > 32) invalid('Configured checks exceed the 32-rule limit after mandatory workflow checks.');
  return validateGatePolicy({ schemaVersion: 1, id, version: Math.max(first.version, last.version), ready: { chat: first.rules.chat, patch: [...readyRequired, ...first.rules.patch] }, done: { chat: last.rules.chat, patch: [...doneRequired, ...last.rules.patch] }, reviewer: { enabled: false, provider: 'same', maxAttempts: 1 }, rework: { maxAttempts: 0 } });
}
export function featureGateInput(input                    )            {
  return { kind: 'patch', title: input.title, message: input.message, criteria: [...input.criteria], files: input.paths .map(path => ({ path, bytes: null })) };
}
export function evaluateFeatureDone(policy            , facts                  ) {
  // Only the coordinator supplies independently recorded facts. A model reply is never evidence for tests/build.
  return evaluateGate(validateGatePolicy(policy), 'done', 'patch', facts);
}
export const featureContentHash = (content        ) => createHash('sha256').update(content).digest('hex');
export const featureInputHash = (input                    ) => gateDigest(input);
