                                                                       
                                                                                  

                              
                          
                                 
                                
                                             
                                                                             
                                            
                                     
                                                                                         
 

/** Read the board's authoritative occupancy: queued work, preparation and continuation reservations. */
export function sharedFeatureAdmissionHold(workspace                    )                                  {
  if (!workspace.acceptingTasks) return { code: 'stopping', message: 'The worker is stopping. This ready request will be checked again when the worker restarts.' };
  if (workspace.configurationUpdating || workspace.repositoriesUpdating || workspace.executionProfiles?.pending()) return { code: 'configuration', message: 'Worker configuration is changing. This ready request will be checked again automatically after the update.' };
  if (workspace.settings.value.board.paused) return { code: 'paused', message: 'The worker queue is paused. Resume the queue; this ready request will then be checked again automatically.' };
  const consumption = workspace.consumption.status();
  if (consumption.blocked) {
    if (consumption.reason === 'accounting_unavailable') return { code: 'budget', message: 'Consumption accounting is unavailable. Repair the private accounting storage and restart the worker; this ready request will then be checked again automatically.' };
    const reason = consumption.reason === 'unmeasured_usage'
      ? 'A provider invocation has incomplete usage.'
      : consumption.reason === 'insufficient_reservation'
        ? 'The remaining configured allowance cannot cover a new model invocation.'
        : 'The worker has used its configured token allowance.';
    return { code: 'budget', message: reason + ' This ready request will be checked again automatically when allowance is available. The next UTC allowance window starts at ' + consumption.periodEnd + '.', resumesAt: consumption.periodEnd };
  }
  if (workspace.sessions.chatActive + workspace.board.active >= workspace.settings.value.board.queueCapacity) return { code: 'capacity', message: 'The worker queue is full. This ready request will be checked again automatically when a local queue place becomes available.' };
  return undefined;
}
