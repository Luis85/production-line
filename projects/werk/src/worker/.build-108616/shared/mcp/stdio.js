import { ValidationError } from '../errors.js';
import { buildInfo } from '../build-info.js';
                                                      
import { ToolCatalog, validateArguments,           } from './catalog.js';

const INPUT_LIMIT = 64 * 1024;
const OUTPUT_LIMIT = 1024 * 1024;
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
                                        
const plainObject = (value         )                                   => value !== null && typeof value === 'object' && !Array.isArray(value);

/** MCP stdio transport: one UTF-8 JSON-RPC message per newline; stdout is protocol-only. */
export async function serveStdio(catalog                                                   , role      , input           = process.stdin, output           = process.stdout)                {
  let initialized = false, ready = false;
  let outputFailure                   ;
  const outputFailed = (cause       ) => { outputFailure = cause; input.destroy(); };
  output.on('error', outputFailed);
  const send = async (message         ) => {
    if (outputFailure) throw outputFailure;
    let encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded) > OUTPUT_LIMIT) {
      const id = (message                      ).id ?? null;
      encoded = JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Response exceeds 1 MiB; narrow the query or reduce its limit. No mutation was retried.' } });
    }
    await new Promise      ((resolve, reject) => output.write(encoded + '\n', error => error ? reject(error) : resolve()));
  };
  const error = (id           , code        , message        ) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const result = (id           , value         ) => send({ jsonrpc: '2.0', id, result: value });

  const handle = async (line        ) => {
    let value         ;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
    catch { await error(null, -32700, 'Parse error');return; }
    if (!plainObject(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string' ||
        (Object.hasOwn(value, 'id') && !['string', 'number'].includes(typeof value.id)) ||
        (typeof value.id === 'number' && !Number.isFinite(value.id))) {
      await error(null, -32600, 'Invalid Request');return;
    }
    const notification = !Object.hasOwn(value, 'id');
    if (notification) {
      if (value.method === 'notifications/initialized' && initialized) ready = true;
      // No logs/progress/cancellation capabilities are advertised; notifications never get responses.
      return;
    }
    const id = value.id                   ;
    if (typeof id === 'string' && id.length > 200) { await error(null, -32600, 'Request ID too long');return; }
    const params = value.params === undefined ? {} : value.params;
    if (!plainObject(params)) { await error(id, -32602, 'Invalid params');return; }
    if (value.method === 'ping') { await result(id, {});return; }
    if (value.method === 'initialize') {
      if (initialized) { await error(id, -32600, 'Already initialized');return; }
      if (typeof params.protocolVersion !== 'string' || !plainObject(params.capabilities) ||
          !plainObject(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
        await error(id, -32602, 'initialize requires protocolVersion, capabilities and clientInfo');return;
      }
      initialized = true;
      await result(id, { protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: `werk-${role}`, version: buildInfo.version }, instructions: 'Werk tools access one configured service. Mutations require explicit enablement and idempotencyKey. There are no worker completion or lease override tools.' });return;
    }
    if (!initialized || !ready) { await error(id, -32002, 'Initialize and send notifications/initialized before using tools');return; }
    if (value.method === 'tools/list') {
      if (params.cursor !== undefined) { await error(id, -32602, 'This bounded catalog has no pagination cursor');return; }
      await result(id, { tools: catalog.definitions });return;
    }
    if (value.method === 'tools/call') {
      if (typeof params.name !== 'string' || !catalog.has(params.name)) { await error(id, -32602, 'Unknown or disabled tool');return; }
      const definition = catalog.definitions.find(tool => tool.name === params.name) ;
      const args = params.arguments === undefined ? {} : params.arguments;
      try { validateArguments(args, definition.inputSchema); }
      catch { await error(id, -32602, 'Invalid tool arguments; follow the tool inputSchema');return; }
      let response;
      try {
        const data = await catalog.call(params.name, args);
        response = { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'Werk tool operation failed';
        response = { content: [{ type: 'text', text: message }], isError: true };
      }
      // A failed protocol write terminates the session; it is not another tool failure to send.
      await result(id, response);
      return;
    }
    await error(id, -32601, 'Method not found');
  };

  // Reuse one bounded frame: fragmented input is copied once, not concatenated quadratically.
  const pending = Buffer.allocUnsafe(INPUT_LIMIT);
  let size = 0;
  try {
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        if (size + end - start > INPUT_LIMIT) { await error(null, -32600, 'Input exceeds 64 KiB');return; }
        size += chunk.copy(pending, size, start, end);
        if (newline < 0) break;
        await handle(pending.subarray(0, size));
        size = 0;
        start = newline + 1;
      }
    }
    if (outputFailure) throw outputFailure;
    if (size) await error(null, -32700, 'Incomplete message: newline delimiter required');
  } finally { output.off('error', outputFailed); }
}

export async function serveWerkMcp(role      , options                        , environment                    = process.env)                {
  if (options['allow-writes'] !== undefined && !['true', 'false'].includes(options['allow-writes'])) throw new ValidationError('--allow-writes must be true or false');
  const base = options.url ?? (role === 'factory' ? environment.WERK_FACTORY_URL : environment.WERK_URL) ?? `http://127.0.0.1:${role === 'factory' ? 3100 : 3000}`;
  const token = (role === 'factory' ? environment.WERK_FACTORY_ADMIN_TOKEN : environment.WERK_ADMIN_TOKEN) ?? '';
  const catalog = new ToolCatalog(role, base, token, options['allow-writes'] === 'true');
  await serveStdio(catalog, role);
}
