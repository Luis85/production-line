import { createHash } from "node:crypto";

export const templateVersion = 1;

export const manifestPath = ".werk/agent-integrations.json";

export const pendingPath = ".werk/agent-integrations.pending.json";

export const lockPath = ".werk/agent-integrations.lock";

export const paths = [
  ".claude/skills/werk-worker/SKILL.md",
  ".agents/skills/werk-worker/SKILL.md",
  ".codex/werk-worker.md",
]         ;

export const hash = (text        ) => createHash("sha256").update(text).digest("hex");

export const digest = (value         )                  =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

                           
                   
                          
                                            
 

                          
                   
                                        
                             
                                                                              
 

                              
                      
                        
                      
                         
 

                                  
               
                                                                   
                                                    
                        
                               
                        
                  
                        
 

                                  
                   
                     
                           
                 
                    
                            
                           
                                                
 

                                                                
                   
                    
                    
                    
 
