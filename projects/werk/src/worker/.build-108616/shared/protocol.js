                                                               
                                               
/** Authenticated worker data. Credentials are never included in public summaries. */
                               
               
                    
                        
                 
                         
 
/** Public operational policy is an allowlist; configuration identity remains worker-owned. */
                                                                                                                                                      
                                                                                                   
                               
                    
 
export function publicWorkerPolicy(policy              )                     {
    return {
        maxParallel: policy.maxParallel, order: policy.order, maxAttempts: policy.maxAttempts,
        ...(policy.queueCapacity === undefined ? {} : { queueCapacity: policy.queueCapacity }),
        ...(policy.repositoryIds === undefined ? {} : { repositoryIds: [...policy.repositoryIds] }),
        ...(policy.legacyRepository === undefined ? {} : { legacyRepository: policy.legacyRepository }),
    };
}
/** Admin projection; excludes worker credentials, config hashes and lease authority. */
                               
               
                    
                        
                 
                    
                                                                        
                                                                                                                        
                                  
 
                            
                
                 
               
                    
 
                                 
                
                       
                   
                       
 
                                          
               
                   
 
                                
                     
                    
                  
                   
                    
                           
                   
 
                                      
                        
                          
 
                                       
               
                  
                    
 
/** Worker-owned compare-and-swap; hashes never appear in public worker summaries. */
                                        
                        
                                      
                              
 
                                         
                        
                              
 
                               
                      
                           
                             
                               
 
                                
                      
 
                               
                  
                    
 
/** Supplying limit or cursor opts into a bounded, resumable collection page. */
                            
                   
                    
 
                                     
                              
                     
 
                                                                       
                  
 
                                                                         
                             
 
                                                                         
                        
 
                                       
                                
                              
                     
 
                                 
                
                                   
                   
 
                                
                  
 
