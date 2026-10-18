import { settleCleanup, withCleanup,                  } from '../shared/lifecycle.js';
                                                                             
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import {                                               } from "../shared/contracts.js";
import { ensureDirectory } from "./infrastructure/journal/files.js";
import {                         } from "./infrastructure/codex-adapter.js";
import { retryableTransportError } from "./infrastructure/orchestrator-client.js";
                                                            
import { reportWithRetry as retryReport } from "./application/reporting.js";
import { runLockedWorker } from './runner-runtime.js';

export { MockAdapter } from "./infrastructure/mock-adapter.js";

/** Backwards-compatible helper; application code consumes transport-independent failures. */
export function reportWithRetry   (
  operation                  ,
  signal             ,
)             {
  return retryReport(operation, signal, retryableTransportError);
}

                               
               
                   
                          
                                                                     
                        
                      
                     
                     
                 
                 
                    
                       
                           
                       
                      
                                 
                                         
                                                                     
                         
                             
                          
 

                                     
                                                                        
                          
                    
                     
 

export async function runWorker(
  config              ,
  stop             ,
  dependencies                     = {},
) {
  if (
    config.policy.maxParallel !== 1 ||
    config.profiles.some((profile) => (profile.maxParallel ?? 1) !== 1)
  )
    throw Error(
      "A worker and each profile must have exactly one execution slot",
    );
  if (
    config.retainedPairs !== undefined &&
    (!Number.isSafeInteger(config.retainedPairs) ||
      config.retainedPairs < 0 ||
      config.retainedPairs > 100000)
  )
    throw Error("retainedPairs must be an integer in 0–100000");
  config = { ...config, profiles: structuredClone(config.profiles), policy: { ...config.policy } };
  await ensureDirectory(config.stateDir);
  const lock = join(config.stateDir, "worker.lock");
  const handle = await open(lock, "wx", 0o600).catch(() => {
    throw Error(
      "State directory is locked. After a crash, verify the old process is stopped before deleting worker.lock.",
    );
  });
  const cleanup                = [
    () => handle.close(),
    () => unlink(lock),
  ];
  return withCleanup(
    () => runLockedWorker(config, stop, dependencies, handle, cleanup),
    () => settleCleanup(...cleanup),
  );
}
