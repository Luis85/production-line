import { launchProcess, terminateProcess } from '../../shared/process/launcher.js';
import { abortFailure, encodeMessage, MCP_WIRE_LIMIT, McpClientError, parseMessage, rpcResult, type McpClientOptions, type McpSession, type McpTransportConfiguration } from './tool-mcp-protocol.js';

/** Only OS/process lookup settings are inherited; provider and worker credentials never are. */
export function mcpEnvironment(source: NodeJS.ProcessEnv, configured: Record<string, string>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'SYSTEMDRIVE', 'PATHEXT', 'COMSPEC']) {
    const entry = Object.entries(source).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (entry?.[1]) result[entry[0]] = entry[1];
  }
  return { ...result, ...configured };
}

/** One ephemeral connection per discovery/call. No shell, automatic retry or ambient login. */
export function openMcpStdio(config: Extract<McpTransportConfiguration, { transport: 'stdio' }>, options: McpClientOptions, signal: AbortSignal): McpSession {
  const launch = options.dependencies?.launch ?? launchProcess;
  const terminate = options.dependencies?.terminate ?? terminateProcess;
  let child: ReturnType<typeof launchProcess>;
  try { child = launch(config.executable, config.args, { cwd: options.directory, env: mcpEnvironment(options.dependencies?.environment ?? process.env, config.env), mode: 'contained', verbatimCmd: true, observation: { kind: 'mcp', label: 'MCP connection' } }); }
  catch { throw new McpClientError('unavailable'); }
  let id = 0, bytes = 0, size = 0, failure: McpClientError | undefined, closed = false;
  let pending: { id: number; resolve(value: unknown): void; reject(error: Error): void } | undefined;
  const frame = Buffer.allocUnsafe(MCP_WIRE_LIMIT);
  let closeResolve!: () => void;
  const exited = new Promise<void>(resolve => { closeResolve = resolve; });
  const fail = (error: McpClientError) => {
    failure ??= error;
    const current = pending; pending = undefined; current?.reject(failure);
    terminate(child, 'SIGKILL');
  };
  const send = (message: unknown): Promise<void> => {
    if (failure) return Promise.reject(failure);
    if (signal.aborted) return Promise.reject(abortFailure(signal));
    let text: string;
    try { text = encodeMessage(message); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => child.stdin.write(text + '\n', error => error ? reject(new McpClientError('unavailable')) : resolve()));
  };
  const handle = (line: Buffer) => {
    const message = parseMessage(line);
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) throw new McpClientError('protocol');
      if (!Object.hasOwn(message, 'id')) return; // Notifications are data, never worker instructions.
      if (typeof message.id !== 'string' && !Number.isSafeInteger(message.id)) throw new McpClientError('protocol');
      // We advertise no sampling, roots, elicitation or other host capabilities.
      const response = message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Client capability is unavailable' } };
      void send({ jsonrpc: '2.0', id: message.id, ...response }).catch(() => fail(new McpClientError('unavailable')));
      return;
    }
    if (!pending) throw new McpClientError('protocol');
    const current = pending;
    const result = rpcResult(message, current.id);
    pending = undefined; current.resolve(result);
  };
  const collect = (chunk: Buffer, protocol: boolean) => {
    bytes += chunk.length;
    if (bytes > MCP_WIRE_LIMIT) { fail(new McpClientError('output_limit')); return; }
    if (!protocol || failure) return;
    try {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
        size += chunk.copy(frame, size, start, end);
        if (newline < 0) break;
        handle(frame.subarray(0, size)); size = 0; start = newline + 1;
      }
    } catch (error) { fail(error instanceof McpClientError ? error : new McpClientError('protocol')); }
  };
  child.stdout.on('data', chunk => collect(Buffer.from(chunk), true));
  child.stderr.on('data', chunk => collect(Buffer.from(chunk), false));
  child.stdin.on('error', () => fail(new McpClientError('unavailable')));
  child.once('error', () => fail(new McpClientError('unavailable')));
  child.once('exit', () => { terminate(child, 'SIGKILL'); });
  child.once('close', () => {
    closed = true; signal.removeEventListener('abort', cancel); closeResolve();
    // A contained Windows launch can fail through its supervisor's exit, without a child error.
    // An unanswered request means unavailable; partial protocol output remains malformed.
    if (size) fail(new McpClientError('protocol'));
    else if (pending) fail(new McpClientError('unavailable'));
    else failure ??= new McpClientError('unavailable');
  });
  const cancel = () => fail(abortFailure(signal));
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  return {
    async request(method, params) {
      if (failure) throw failure;
      if (pending) throw new McpClientError('protocol');
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        pending = { id: requestId, resolve, reject };
        void send({ jsonrpc: '2.0', id: requestId, method, params }).catch(error => fail(error instanceof McpClientError ? error : new McpClientError('unavailable')));
      });
    },
    notify: (method, params) => send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }),
    async close() {
      signal.removeEventListener('abort', cancel);
      if (closed) return;
      terminate(child, 'SIGKILL');
      // Kernel process termination normally closes immediately; also bound broken injected streams.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); timer.unref(); })]);
      if (timer) clearTimeout(timer);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    },
  };
}
