                                                       

/** Private identity retained at task admission; never part of the model dispatch. */
                                                                                        
/**
 * Execution limits captured with an invocation, as dispatch evidence. `callTimeoutMs` names each
 * tool with its own deadline; `werk_command_run` reports its longest preset and `presetTimeoutMs`
 * each preset. `windowMs` records the existing overall invocation budget; it is not a separate
 * tool-policy window. File tools have no separate deadline.
 */
                                                                                                                                                            
/** Public invocation snapshot. Credentials and host paths never belong in a dispatch. */
                                                                                                         
                                                                                             
/**
 * Evidence that an invocation's shared tool budget ran out: the call limit was reached or the
 * tool window ended. Counts and durations only; never tool names, arguments, results or paths.
 * `callsUsed` counts calls admitted to execution; `refusedCalls` counts calls that returned the
 * budget message instead of a tool result, including a call stopped when the window ended.
 */
                                                                                                                                                
                                                                                                                                                  
                              
                                  
                                                                                  
                                                                                                   
                                                                              
                                                                                                             
                                              
                                                                                                      
                        
                                                                                           
                         
 
export class ToolAccessError extends Error {
  constructor(message = 'Tool access is unavailable. Check the current worker tool permissions.') { super(message); this.name = 'ToolAccessError'; }
}
