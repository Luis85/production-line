                                                              
import { validateFeatureRequestReference,                              } from './feature-request-reference.js';

import {                                                                             } from './development.js';
                                                           

                                                              
                                                         

import { gateDigest, validateGateInput, validateGatePolicy,                 } from "./request-gates.js";

import {                         } from "./definitions.js";
import { createHash } from "node:crypto";

import { object } from "../../shared/contracts.js";
import { DomainError } from "../../shared/errors.js";

/** Repository adapters prepare committed worktrees; plain folders remain a legacy fallback. */
                                      
                  
                     
                    
                        
                        
              
                          
                       
                 
                        
                     
                                                                                      
                       
     
                                                                                                                
                                                          
                                                                                 
                  
                     
                    
                        
                                                                            
                                                                                
 
/** One budget covers queueing, fetch, checkout and verification of a new task worktree. */
export const ADMISSION_TIMEOUT_MS = 120000;
/** Background admission does not hold an HTTP request open, so large checkouts get more time. */
export const BACKGROUND_ADMISSION_TIMEOUT_MS = 600000;
/** In-memory admission accepted with `background: true`; never persisted across restarts. */
                                       
             
                
                     
                                
                                              
                       
                    
                            
 
/** Trusted coordinator reservation; these fields are never accepted from a task HTTP body. */
                                      
                                    
             
               
                      
                      
                        
                      
 
export function freezeSubmission(input                     )                      {
  const value = object(input, "Task reservation", ["id", "hash", "policy", "criteria", "repositoryId", "baseCommit", "feature"]);
  if (typeof value.id !== "string" || !/^[a-z0-9-]{1,90}$/.test(value.id) ||
      typeof value.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.hash))
    throw new DomainError("invalid_input", "Invalid feature task identity.");
  if (value.repositoryId !== undefined && (typeof value.repositoryId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value.repositoryId)))
    throw new DomainError("invalid_input", "Invalid reserved repository ID.");
  if (value.baseCommit !== undefined && (typeof value.baseCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.baseCommit)))
    throw new DomainError("invalid_input", "Task base must be a full Git commit identifier.");
  return {
    id: value.id,
    hash: value.hash,
    ...(value.feature === undefined ? {} : { feature: validateFeatureRequestReference(value.feature) }),
    ...(value.policy === undefined ? {} : { policy: validateGatePolicy(value.policy) }),
    ...(value.criteria === undefined ? {} : { criteria: validateGateInput({ kind: "patch", title: "", message: "", criteria: value.criteria }).criteria }),
    ...(value.repositoryId === undefined ? {} : { repositoryId: value.repositoryId           }),
    ...(value.baseCommit === undefined ? {} : { baseCommit: value.baseCommit           }),
  };
}
export function submissionContextHash(submission                      ) {
  const context = { policy: submission?.policy, criteria: submission?.criteria, repositoryId: submission?.repositoryId, baseCommit: submission?.baseCommit };
  return Object.values(context).some(value => value !== undefined) ? gateDigest(context) : undefined;
}
                           
               
                  
                   
 
                            
                                              
                                    
                                    
                                            
                                                                                  
                                                
                     
                            
                 
                         
                          
                                 
                          
                      
                                  
             
                
                      
                    
                       
                
                     
                        
                    
                       
                                                                                           
                                         
                                          
                      
                    
                          
                   
                    
                            
                       
                         
                       
                    
 
export const fingerprint = (value        ) =>
  createHash("sha256").update(value).digest("hex");
