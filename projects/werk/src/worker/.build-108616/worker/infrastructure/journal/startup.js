                                                                           
                                                                               
import { restoreSessionCatalog } from '../../application/session-catalog.js';
import { isPreparedLocalTask } from '../../application/queued-task-recovery.js';
                                                          
                                                                  
                                                        
import { localTaskStorage, sessionCatalogStorage } from './workspace-files.js';

/** Only the standard local startup coordinates preservation; standalone journals remain conservative. */
export async function initializeLocalEvidence(directory        , settings                    , requests                      , interactions                          , runs                  ) {
  try {
    await requests.open(); await interactions.open(); await runs.open();
    const saved = await localTaskStorage(directory).read();
    const value          = saved === undefined ? [] : JSON.parse(saved);
    const tasks              = Array.isArray(value) && value.length <= 100 ? value : [];
    const records = restoreSessionCatalog(await sessionCatalogStorage(directory).read(), settings).records;
    const requestIds = new Set        (), turnIds = new Set        (), runIds = new Set        ();
    for (const task of tasks) {
      if (!isPreparedLocalTask(task, { requests, interactions, runs }, records)) continue;
      // Contradictory ownership cannot be made safe by choosing the first saved projection.
      if (tasks.some(other => other !== task && (other?.id === task.id || other?.sessionId === task.sessionId || other?.requestId === task.requestId || other?.currentTurnId === task.currentTurnId || other?.runId === task.runId))) continue;
      if (!requests.preparedForRecovery(task.requestId ) || !interactions.preparedForRecovery(task.sessionId, task.currentTurnId ) || !runs.queuedForRecovery(task.runId )) continue;
      requestIds.add(task.requestId ); turnIds.add(task.currentTurnId ); runIds.add(task.runId );
    }
    requests.recover(requestIds);
    interactions.recover(turnIds);
    await runs.recover(id => interactions.resultForRun(id), runIds);
  } catch (error) { requests.close(); interactions.close(); runs.close(); throw error; }
}
