import { DomainError } from '../../shared/errors.js';
                                                          
import { validateFeatureRequestReference,                              } from './feature-request-reference.js';
                                                                     

                                   
                      
                                     
                 
                         
                      
                       
                                                                    
 
                                        
                                                                            
                                                                             
 
/** All intake adapters dispatch the same accepted Feature Request; executors own attempts. */
export async function admitFeatureRequest(ports                       , admission                  )                {
  const { input } = admission, feature = validateFeatureRequestReference(admission.reference);
  const selection = {
    title: input.title, provider: input.provider, definitionId: input.definitionId,
    definitionRef: input.definitionRef, agent: input.agent, useInstructionsOnly: input.useInstructionsOnly,
  };
  if (input.mode === 'patch') {
    if (!admission.repository) throw new DomainError('invalid_input', 'A file implementation needs its accepted repository.');
    await ports.patch({ ...selection, instruction: input.message, repository: admission.repository,
      paths: input.paths, priority: input.priority, ...(admission.background ? { background: true } : {}),
    }, { ...admission.submission, id: admission.taskId, hash: admission.submissionHash, feature });
  } else if (input.mode === 'chat') {
    await ports.chat({ ...selection, action: 'create', id: admission.taskId, message: input.message }, feature);
  } else throw new DomainError('invalid_input', 'Unsupported feature request execution mode.');
}
