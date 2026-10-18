import { DomainError } from '../../shared/errors.js';

/** Worker-session evidence excludes prompt text, credentials, provider subprocess accounting and inferred prices. */
                                
                                                                                                                           
                                                                                  
                                                                                                             
 
export const unknownUsage = (reason = 'The provider did not report usage for this attempt.')                => ({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, providerReportedCostUsd: null, costBasis: 'unavailable', source: 'unavailable', reason });
                                                                                                                                                
                                                                                                                                                                                                                                                                                                         
                                    
                                     
                                                                                                                                                                   
                                                                                                                                              
 
                                                                                                                                                                                                     
                                                                                                                                                                                                 
                                                
                                                                                       
                                                                                                      
                                                                                  
                                                                                                                             
 
                                                                                                                                                                                                                                                                          
                                                                                                                                                                                        
                              
                   
                                                                                          
                                                                   
                                                                                    
                                                                                                                                                                                    
                  
 
                              
                                                   
                                   
                                                        
                                                                                                                    
 

/** Delegation is an invocation of the same FR, never a second lifecycle or another nested parent. */
export function validateRunLineage(metadata             , parent            )       {
  if ([metadata.parentRunId, metadata.parentSessionId, metadata.delegationId].every(value => value === undefined)) return;
  if (!parent || parent.id !== metadata.parentRunId || parent.sessionId !== metadata.parentSessionId || parent.parentRunId !== undefined
    || parent.outcome !== 'running' || parent.after !== null || !parent.startedAt
    || typeof metadata.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(metadata.sessionId) || metadata.sessionId === parent.sessionId
    || typeof metadata.delegationId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(metadata.delegationId)
    || ['taskId', 'requestId', 'kind', 'provider', 'model'].some(key => metadata[key                     ] !== parent[key                     ])
    || (metadata.purpose ?? 'execution') !== (parent.purpose ?? 'execution')) throw new DomainError('conflict', 'Delegated execution must belong to its active parent Feature Request.');
}
