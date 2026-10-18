                                                                                         
                                                                             
                                                        
                                                        
                                                                                         
import { DomainError } from '../../shared/errors.js';
                                                                                  

export const defaultSharedIntakeConfig = ()                     => ({ enabled: false, repositoryId: '', remote: 'origin', branch: 'main', workflowPath: '.werk/feature-workflow.json', pollMs: 5000 });
export function validateSharedIntakeConfig(value         )                     {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('invalid_input', 'Shared intake requires a configuration object.');
  const d = value                           ;
  const fields = ['enabled', 'repositoryId', 'remote', 'branch', 'workflowPath', 'pollMs'];
  if (Object.keys(d).some(k => !fields.includes(k))) throw new DomainError('invalid_input', `Shared intake configuration accepts only ${fields.join(', ')}.`);
  // Saving replaces the whole binding; a partial object would silently reset omitted fields.
  const missing = fields.filter(k => !Object.hasOwn(d, k));
  if (missing.length) throw new DomainError('invalid_input', `Shared intake configuration is incomplete; missing ${missing.join(', ')}. Send the complete config from shared status with your changes.`);
  if (typeof d.enabled !== 'boolean') throw new DomainError('invalid_input', 'Shared intake enabled must be true or false.');
  if (typeof d.repositoryId !== 'string' || !/^[a-zA-Z0-9_-]{0,100}$/.test(d.repositoryId) || (d.enabled && !d.repositoryId)) throw new DomainError('invalid_input', 'Choose an assigned repository.');
  if (typeof d.remote !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(d.remote)) throw new DomainError('invalid_input', 'Choose a configured Git remote name.');
  if (typeof d.branch !== 'string' || d.branch.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(d.branch) || d.branch.includes('..') || d.branch.includes('//') || d.branch.split('/').some(p => !p || p.startsWith('.') || p.endsWith('.') || p.endsWith('.lock'))) throw new DomainError('invalid_input', 'Use a valid Git intake branch name.');
  if (typeof d.workflowPath !== 'string' || d.workflowPath.length > 500 || !d.workflowPath.endsWith('.json') || /[\\\x00-\x1f\x7f:]/.test(d.workflowPath) || d.workflowPath.split('/').some(p => !p || p === '.' || p === '..' || p === '.git' || p === 'node_modules')) throw new DomainError('invalid_input', 'Use a repository-relative workflow JSON path.');
  if (!Number.isSafeInteger(d.pollMs) || Number(d.pollMs) < 1000 || Number(d.pollMs) > 300000) throw new DomainError('invalid_input', 'Shared intake interval must be 1,000–300,000 milliseconds.');
  return structuredClone(d)                                 ;
}
                                                                                              
                                 
                      
                                                                       
                                                                                  
 
                                       
                                             
                                                                                      
                                                                           
                                                                                                          
                                                                                                                                                                                                                
 
                                       
                             
               
                   
                          
                   
                                                                                            
                                                                 
                                                                                                                                                            
 
                                                                
                              
                     
                         
                         
                               
                    
                                    
                   
                     
                           
                          
                         
                        
                          
                           
                              
                                                                      
                    
 
                                     
                   
                   
                   
                             
                                 
 
                                  
                 
                                
                         
                       
                                        
                                            
                                                                                         
                                
                                
                         
                 
                        
 
/** A start restriction, distinct from invalid Feature Request content. */
                                      
                                                                                             
                  
                                                                                                
                     
 
                                    
                                      
                                                 
                                                                                                    
                                                                                                                                      
                                                                                                                                                                              
                                                                                                       
                                                    
                                                     
                                                                                        
                                                       
                      
                                                                                      
                                                    
                                                                                                                                                               
                                                                 
 
export function bindingKey(config                    ) { return JSON.stringify([config.repositoryId, config.remote, config.branch, config.workflowPath]); }
export const sharedTerminal = (status        ) => ['ready_for_review', 'failed', 'cancelled'].includes(status);

export const sharedTaskActive = (record                     ) => !!record.task && !record.task.closed && record.task.response?.status !== 'processed';
