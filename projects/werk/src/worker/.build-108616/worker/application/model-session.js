import { createHash } from 'node:crypto';

/** A logical FR session is distinct from provider handles, turns and execution runs. */
                                      
                   
                           
                            
                     
                     
 
/** Provider-owned checkpoint data stays private and never authorizes tools. */
                                         
                    
                                 
                            
                        
                                    
 
                                     
                                         
                                      
                              
 
                                                               
                   
                               
                   
 
                                   
                                                                 
                                                                                                                     
 
                                                                                              
const record = (value         )                                   => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value         )                  => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const sessionDigest = (value         ) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validateModelSessionBinding(value         )                                       {
  if (!record(value) || Object.keys(value).some(key => !['schemaVersion', 'logicalSessionId', 'featureRequestKey', 'providerId', 'generation'].includes(key))
    || value.schemaVersion !== 1 || typeof value.logicalSessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.logicalSessionId)
    || typeof value.featureRequestKey !== 'string' || !/^fr-[a-f0-9]{64}$/.test(value.featureRequestKey)
    || !['codex-cli', 'claude-cli', 'openai-api', 'anthropic-api'].includes(String(value.providerId))
    || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1) throw Error('Invalid model session binding.');
}
export function validateModelSessionUpdate(value         )                                      {
  if (!record(value) || Object.keys(value).some(key => !['status', 'checkpoint', 'lastDispatchDigest'].includes(key))
    || !['idle', 'running', 'unknown'].includes(String(value.status)) || value.lastDispatchDigest !== undefined && !hash(value.lastDispatchDigest)) throw Error('Invalid model session checkpoint.');
  if (value.checkpoint === undefined) return;
  const c = value.checkpoint;
  if (!record(c) || Object.keys(c).some(key => !['nativeId', 'providerContextDigest', 'historyDigests', 'resultDigest', 'cumulativeCostUsd'].includes(key))
    || c.nativeId !== undefined && (typeof c.nativeId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(c.nativeId))
    || c.providerContextDigest !== undefined && !hash(c.providerContextDigest) || c.resultDigest !== undefined && !hash(c.resultDigest)
    || c.historyDigests !== undefined && (!Array.isArray(c.historyDigests) || c.historyDigests.length > 10000 || c.historyDigests.some(item => !hash(item)))
    || c.cumulativeCostUsd !== undefined && c.cumulativeCostUsd !== null && (typeof c.cumulativeCostUsd !== 'number' || !Number.isFinite(c.cumulativeCostUsd) || c.cumulativeCostUsd < 0)) throw Error('Invalid provider session checkpoint.');
}
