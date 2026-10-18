                                                                                        

                                       
                                                                                           
                                                                        
                                        
                       
                                
                                      
                                  
 
                                   
                       
                     
                     
                                       
 
                             
                                                                             
                                                                          
                           
                         
 
                                                                                                                                        
const messages                             = {
  configuration: 'MCP connection configuration is invalid.',
  denied: 'This MCP tool is not granted.',
  cancelled: 'MCP operation was cancelled.',
  timeout: 'MCP operation exceeded its time limit.',
  unavailable: 'MCP connection failed. Check the endpoint, command and credentials.',
  protocol: 'MCP server returned an unsupported or malformed response.',
  output_limit: 'MCP response exceeds the worker limit. Narrow the server catalog or tool result.',
  changed: 'MCP tool definition changed. Check the connection and review its grants again.',
};
/** Deliberately excludes server diagnostics, endpoints, command arguments and secrets. */
export class McpClientError extends Error {
           reason            ;
  constructor(reason            ) { super(messages[reason]); this.name = 'McpClientError'; this.reason = reason; }
}
export const MCP_WIRE_LIMIT = 1024 * 1024;
export const MCP_REQUEST_LIMIT = 64 * 1024;
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const plainObject = (value         )                                   => value !== null && typeof value === 'object' && !Array.isArray(value);
export function parseMessage(bytes            )                          {
  try {
    const value          = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!plainObject(value) || value.jsonrpc !== '2.0') throw new Error();
    return value;
  } catch { throw new McpClientError('protocol'); }
}
export function rpcResult(message                         , id        )          {
  if (message.id !== id || Object.hasOwn(message, 'method') || Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) throw new McpClientError('protocol');
  if (Object.hasOwn(message, 'error')) {
    if (!plainObject(message.error) || !Number.isSafeInteger(message.error.code) || typeof message.error.message !== 'string') throw new McpClientError('protocol');
    throw new McpClientError('unavailable');
  }
  return message.result;
}
export function encodeMessage(message         )         {
  let text        ;
  try { text = JSON.stringify(message); } catch { throw new McpClientError('protocol'); }
  if (Buffer.byteLength(text) > MCP_REQUEST_LIMIT) throw new McpClientError('output_limit');
  return text;
}
export function abortFailure(signal             )                 {
  return signal.reason instanceof McpClientError ? signal.reason : new McpClientError('cancelled');
}
