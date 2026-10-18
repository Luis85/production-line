import { DomainError } from './errors.js';
import { webUrl } from './factory.js';
import { identifier, object, text } from './validation.js';

                                                               
                                      
                                                 
                                                   
                                                           
                                                                               
/** Extensions remain available to existing clients; consumers must narrow unknown fields. */
                                           
                         
              
                             
               
                 
 
                                        
                         
                     
                
                 
                                       
 
                                           
                         
             
                
                    
                 
                  
 
                                            
                         
                   
                                      
 
                                               
                         
                                      
                              
 
                                            
                         
                   
                              
                                       
 
export function validateWorkerInteractionRequest(value         )                           {
  const body = object(value, 'Worker interaction', ['workerUrl', 'workerToken', 'action', 'message', 'sessionId']);
  const access = { workerUrl: webUrl(body.workerUrl, 'workerUrl', true), workerToken: text(body.workerToken, 'workerToken', 1024) };
  if (body.action === 'read') return { ...access, action: 'read' };
  if (!['new', 'send', 'cancel'].includes(body.action          )) throw new DomainError('invalid_input', 'action: read|send|cancel|new');
  const sessionId = identifier(body.sessionId, 'sessionId');
  return body.action === 'send'
    ? { ...access, action: 'send', sessionId, message: text(body.message, 'message', 8000) }
    : { ...access, action: body.action                    , sessionId };
}
function invalidResponse()        {
  throw new DomainError('unavailable', 'The remote component returned an invalid worker interaction response. Reconnect and retry.');
}
function responseObject(value         )                          {
  try { return object(value, 'Worker interaction response'); } catch { return invalidResponse(); }
}
function responseId(value         )         {
  try { return identifier(value, 'Worker interaction response ID'); } catch { return invalidResponse(); }
}
function optionalString(value         ) { if (value !== undefined && typeof value !== 'string') invalidResponse(); }
function optionalBoolean(value         ) { if (value !== undefined && typeof value !== 'boolean') invalidResponse(); }
export function validateWorkerInteractionStatus(value         )                       {
  const body = responseObject(value);
  return { workerId: responseId(body.workerId) };
}
export function validateWorkerInteractionChat(value         )                        {
  const body = responseObject(value);
  if (typeof body.available !== 'boolean' || typeof body.busy !== 'boolean' || !Array.isArray(body.messages)) return invalidResponse();
  optionalString(body.phase);
  for (const value of body.messages) {
    const message = responseObject(value);
    if (!['user', 'assistant'].includes(message.role          ) || typeof message.text !== 'string') return invalidResponse();
    optionalString(message.id); optionalString(message.state);
  }
  return body                                    ;
}
export function validateWorkerInteractionSessions(value         )                            {
  const body = responseObject(value), selected = responseId(body.selected);
  if (!Array.isArray(body.records)) return invalidResponse();
  const ids = new Set        ();
  for (const value of body.records) {
    const session = responseObject(value), id = responseId(session.id);
    if (ids.has(id) || typeof session.title !== 'string') return invalidResponse();
    ids.add(id);
    if (session.provider !== undefined) responseId(session.provider);
    optionalString(session.status); optionalBoolean(session.busy);
  }
  if (!ids.has(selected)) return invalidResponse();
  return body                                        ;
}
export function validateWorkerInteractionSessionView(value         )                               {
  const body = responseObject(value);
  validateWorkerInteractionSessions(body.sessions); validateWorkerInteractionChat(body.chat);
  return body                                           ;
}
export function validateWorkerInteractionResponse(value         )                            {
  const body = responseObject(value);
  responseId(body.workerId); validateWorkerInteractionChat(body.chat);
  if (body.sessions !== undefined) validateWorkerInteractionSessions(body.sessions);
  return body                                        ;
}
