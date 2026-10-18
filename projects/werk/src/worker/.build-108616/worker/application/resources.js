import { DomainError } from '../../shared/errors.js';

                                 
                        
                      
                     
                       
                        
                          
                        
 
export const defaultResourcePolicy = ()                 => ({ memoryPercent: 85, heapPercent: 90, cpuPercent: 90, cpuSustainMs: 30000, diskFreeBytes: 268435456, diskFreePercent: 5, longRunningMs: 3600000 });
export function validateResourcePolicy(input         )                 {
  const bounds                                                 = { memoryPercent: [1, 100], heapPercent: [1, 100], cpuPercent: [1, 100], cpuSustainMs: [1000, 3600000], diskFreeBytes: [0, 1099511627776], diskFreePercent: [0, 100], longRunningMs: [1000, 86400000] };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !(key in bounds))) throw new DomainError('invalid_input', 'Use the documented resource policy fields.');
  const value = input                  ;
  for (const [key, [minimum, maximum]] of Object.entries(bounds)) {
    const number = value[key                        ];
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new DomainError('invalid_input', `Resource policy ${key} must be an integer between ${minimum} and ${maximum}.`);
  }
  return { ...value };
}
                                                                                                      
                                  
                    
                         
                      
                         
                   
                        
                         
                                           
                                      
                           
                                    
                                
                        
 
                                                                                                   
                     
                               
                                            
                          
                            
                                                                             
 
                                                                                    
                                
             
                          
                      
                   
                     
                   
                    
                              
 
                                
                   
                   
             
                  
                          
                              
             
                                                                                
                   
                    
                     
 
                                                                                                                                                                            
                                 
                   
                           
                         
                                    
                          
                            
                       
                                                                              
 
                                     
                        
                            
                                                                                                                   
                                                            
                
 
