                                                                              
                                                           
                                                           
                                                              

                                                                                     
/** Private worker configuration; credentials never belong in public observations or model dispatches. */
                                                                                                                                
export const providerIds               = ['codex-cli', 'claude-cli', 'openai-api', 'anthropic-api'];
export const providerLabels                             = { 'codex-cli': 'Codex CLI', 'claude-cli': 'Claude Code CLI', 'openai-api': 'OpenAI · API', 'anthropic-api': 'Claude · API' };
export function providerReady(connection                    ) { return connection.id.endsWith('-cli') ? !!connection.executable : !!connection.apiKey && !!connection.model; }
/** The application selects execution scope. The adapter resolves storage and current tool grants. */
                                                                                                                                                                                                         
                                                                                                                 
