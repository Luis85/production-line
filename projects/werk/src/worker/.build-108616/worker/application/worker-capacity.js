                                                          

                                                                                
                                                                                              
                                        
                                                
                                          
 
                                         
                   
                     
                                                                  
                                                                                              
                                                                                
                                                                                                      
                                                                                            
                                                                       
 
                         
                     
                                  
                    
                                                                                  
                                    
                                          
 
/** A synchronous observation of admission facts; retained notes and saved tasks are not queue occupancy. */
export function workerCapacitySnapshot(input               )                         {
  const { settings, remote } = input;
  return {
    schemaVersion: 1, capturedAt: input.capturedAt,
    execution: { limit: 1, inUse: input.currentSessionId === null ? 0 : 1, sessionId: input.currentSessionId },
    local: { limit: settings.queueCapacity, used: input.localUsed, remaining: Math.max(0, settings.queueCapacity - input.localUsed), overLimit: input.localUsed > settings.queueCapacity },
    remote: { ...remote, extraQueuePlaces: settings.orchestratorQueue, accepted: remote.waiting === null || remote.running === null ? null : remote.waiting + remote.running },
    starts: { paused: settings.paused, consumption: input.consumption ? { blocked: input.consumption.blocked, reason: input.consumption.reason } : null },
  };
}
