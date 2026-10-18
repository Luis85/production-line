import { callTimeout } from './tool-limits.js';
import { classifyDevelopmentEvidence } from './development-verification.js';
import { createHash } from 'node:crypto';
import { DomainError } from '../../shared/errors.js';
import { validateApprovedPaths } from './approved-paths.js';
import { gateDigest } from './request-gates.js';
                                                                      
                                                              

/** Frozen authority for a new repository implementation. Never inferred for saved proposal tasks. */
                                                                                                                                            
                                                                                                                                                  
                                           
                                                                       
                                                                       
                                                                                             
 
                                                                                                                                                                         
                                                                                                                                                                  
                                                                                                                                                      
                                     
                                                                                                                              
                                                                                  
                                                              
                                  
 
                                            
                                                                                                        
                                                                   
                                                           
                                                      
                              
 
                                                                                            
                                                                                                                                               
export function developmentScopeView(scope                  )                       {
  return { schemaVersion: 1, mode: 'worktree', baseCommit: scope.baseCommit, approvedPaths: [...scope.approvedPaths], checks: scope.checks.map(({ id, name, fingerprint }) => ({ id, name, fingerprint })) };
}
/** Names participate so edits to the operator's frozen verification plan require a new request. */
export function developmentCheckFingerprint(check                                                                              )         {
  return gateDigest({ id: check.id, name: check.name, executable: check.executable, args: check.args, ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }) });
}
export function freezeDevelopmentScope(baseCommit                    , approvedPaths                   , policy            )                               {
  const checks = policy.builtins.commands.filter(item => item.enabled && item.verification).map(item => ({ id: item.id, name: item.name, executable: item.executable, args: [...item.args], fingerprint: developmentCheckFingerprint(item), ...(item.timeoutMs === undefined ? {} : { timeoutMs: item.timeoutMs }) })).sort((a, b) => a.id.localeCompare(b.id));
  if (!baseCommit || !policy.builtins.files || !checks.length) return;
  const scope                   = { schemaVersion: 1, mode: 'worktree', baseCommit, approvedPaths: [...approvedPaths], checks };
  validateDevelopmentState(scope);
  return scope;
}
export function assertDevelopmentPolicy(scope                  , policy            )       {
  const current = freezeDevelopmentScope(scope.baseCommit, scope.approvedPaths, policy);
  if (!current || gateDigest(current.checks) !== gateDigest(scope.checks))
    throw new DomainError('conflict', 'Repository file access or the required verification commands changed. Create a new request with the current verification plan; retained changes are preserved.');
}
export function developmentVerified(scope                  , candidate                      , evidence                                 )          {
  return !!candidate.patch.trim() && candidate.changedPaths.length > 0 && !!evidence && evidence.candidateDigest === candidate.digest &&
    gateDigest([...candidate.changedPaths].sort()) === gateDigest([...evidence.changedPaths].sort()) &&
    classifyDevelopmentEvidence(scope, evidence).verified;
}
/** Recovered/publication decisions use the immutable captured patch and latest durable receipts together. */
export function developmentCompletionValid(task   
                                                                                                                              
                                                               
 )          {
  const { implementation: scope, developmentEvidence: evidence, developmentCompletion: receipt } = task;
  if (!scope || !evidence || !receipt || receipt.verified !== true || !task.patch || receipt.turnId !== task.currentTurnId || receipt.runId !== task.runId) return false;
  try {
    validateDevelopmentState(scope, evidence);
    return createHash('sha256').update(task.patch).digest('hex') === receipt.patchSha256 && gateDigest(evidence) === receipt.evidenceDigest &&
      receipt.candidateDigest === evidence.candidateDigest && developmentVerified(scope, { patch: task.patch, digest: receipt.candidateDigest, changedPaths: evidence.changedPaths }, evidence);
  } catch { return false; }
}
const object = (value         )                                   => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value         )                  => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = (value         )                  => typeof value === 'string' && Number.isFinite(Date.parse(value));
/** Saved private authority and receipts are validated before any recovery or tool construction. */
export function validateDevelopmentState(scope         , evidence          )                                    {
  const invalid = () => new DomainError('conflict', 'Saved implementation authority or verification evidence is invalid. Retained files require inspection.');
  if (!object(scope) || scope.schemaVersion !== 1 || scope.mode !== 'worktree' || typeof scope.baseCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(scope.baseCommit) || !Array.isArray(scope.checks) || !scope.checks.length || scope.checks.length > 32) throw invalid();
  try { validateApprovedPaths(scope.approvedPaths); for (const check of scope.checks) if (object(check)) callTimeout(check.timeoutMs, 'Required check'); } catch { throw invalid(); }
  if (scope.checks.some(check => !object(check) || typeof check.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(check.id) || typeof check.name !== 'string' || !check.name.trim() || check.name.length > 120 || typeof check.executable !== 'string' || !check.executable.trim() || check.executable.length > 4096 || !Array.isArray(check.args) || check.args.length > 64 || check.args.some(arg => typeof arg !== 'string' || arg.length > 4000 || arg.includes('\0')) || !hash(check.fingerprint) || developmentCheckFingerprint(check                               ) !== check.fingerprint) || new Set(scope.checks.map(check => check.id)).size !== scope.checks.length) throw invalid();
  if (evidence === undefined) return;
  if (!object(evidence) || evidence.schemaVersion !== 1 || evidence.candidateDigest !== null && !hash(evidence.candidateDigest) || !Array.isArray(evidence.changedPaths) || evidence.changedPaths.some(path => !(scope.approvedPaths            ).includes(path)) || new Set(evidence.changedPaths).size !== evidence.changedPaths.length || !date(evidence.updatedAt) || !Array.isArray(evidence.checks) || evidence.checks.length > 32) throw invalid();
  const requiredChecks = scope.checks;
  if (new Set(evidence.checks.map(check => object(check) ? check.presetId : null)).size !== evidence.checks.length) throw invalid();
  if (evidence.checks.some(check => !object(check) || !requiredChecks.some(required => required.id === check.presetId && required.fingerprint === check.presetFingerprint) || !hash(check.candidateDigest) || !['passed', 'failed', 'interrupted'].includes(check.status          ) || check.exitCode !== null && !Number.isSafeInteger(check.exitCode) || check.status === 'passed' && check.exitCode !== 0 || typeof check.stdout !== 'string' || check.stdout.length > 32768 || typeof check.stderr !== 'string' || check.stderr.length > 32768 || !date(check.startedAt) || !date(check.finishedAt) || check.truncated !== undefined && typeof check.truncated !== 'boolean')) throw invalid();
}
