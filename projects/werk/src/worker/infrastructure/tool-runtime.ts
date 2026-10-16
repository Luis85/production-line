import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ToolPolicy } from '../application/tool-policy.js';
import { ToolAccessError, type ToolManifest, type ToolResult, type ToolRuntime, type ToolWorktreeIdentity } from '../application/tool-runtime.js';
import { builtinToolOperations, BuiltinToolError, type ToolOperation } from './builtin-tools.js';
import { callMcpTool, mcpTransportConfiguration } from './tool-mcp.js';

export interface ToolRuntimeOptions {
  policy: ToolPolicy;
  currentRevision: () => number;
  /** Private worker state directory. Chat commands start in its chat-workspace child. */
  directory: string;
  /** An approved, worker-owned task worktree, never a path supplied by the model. */
  worktree?: string;
  worktreeIdentity?: ToolWorktreeIdentity;
  maxCalls?: number;
  maxRuntimeMs?: number;
  fetch?: typeof globalThis.fetch;
}
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
};
/** Stable provider-compatible names avoid collisions and never contain a server URL or secret. */
export function mcpToolName(connection: string, tool: string): string {
  const suffix = createHash('sha256').update(JSON.stringify([connection, tool])).digest('hex').slice(0, 12);
  return 'mcp_' + connection.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 16) + '_' + tool.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24) + '_' + suffix;
}

/** No processes or network sessions are created until the model invokes a granted tool. */
export function createToolRuntime(options: ToolRuntimeOptions): ToolRuntime {
  const policy = structuredClone(options.policy);
  const pinnedWorktree = options.worktreeIdentity ? { ...options.worktreeIdentity } : undefined;
  const maxCalls = options.maxCalls ?? 32, maxRuntimeMs = options.maxRuntimeMs ?? 120000;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 32 || !Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs < 1 || maxRuntimeMs > 3600000) throw new ToolAccessError('Invalid tool execution limits.');
  const operations: ToolOperation[] = builtinToolOperations({ ...options, policy });
  for (const connection of policy.mcp.filter(item => item.enabled)) {
    const granted = connection.discoveredTools.filter(tool => connection.allowedTools.includes(tool.name));
    for (const tool of granted) operations.push({
      definition: { ...tool, name: mcpToolName(connection.id, tool.name), description: `[${connection.name}] ${tool.description}` },
      call: async (args, signal) => {
        const directory = options.worktree ?? join(options.directory, 'chat-workspace');
        if (!options.worktree) await mkdir(directory, { recursive: true, mode: 0o700 });
        return callMcpTool(mcpTransportConfiguration(connection), tool.name, args, granted, { signal, directory, timeoutMs: 30000 });
      }
    });
  }
  if (operations.length > 64) throw new ToolAccessError('At most 64 tools may be granted for one invocation.');
  const catalog = new Map(operations.map(operation => [operation.definition.name, operation]));
  if (catalog.size !== operations.length) throw new ToolAccessError('Tool names are not unique.');
  const manifest: ToolManifest = freeze({ revision: policy.revision, tools: structuredClone(operations.map(operation => operation.definition)) });
  const lifetime = new AbortController();
  const pending = new Set<Promise<ToolResult>>();
  let calls = 0, deadline: AbortSignal | undefined, closed = false;
  let previous: Promise<unknown> = Promise.resolve();
  const authorize = (signal: AbortSignal) => {
    if (closed || signal.aborted) throw new ToolAccessError('Tool execution was cancelled or its invocation ended.');
    let revision; try { revision = options.currentRevision(); } catch { throw new ToolAccessError(); }
    if (revision !== policy.revision) throw new ToolAccessError('Tool permissions changed. Start a new invocation to use the current grants.');
    if (options.worktree && pinnedWorktree) {
      try {
        const info = lstatSync(options.worktree);
        if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(options.worktree) !== resolve(options.worktree) || String(info.dev) !== pinnedWorktree.dev || String(info.ino) !== pinnedWorktree.ino || info.birthtimeMs !== pinnedWorktree.birthtimeMs) throw Error('Identity changed');
      } catch { throw new ToolAccessError('The retained task worktree changed. Create a new task before using its tools.'); }
    }
  };
  return {
    manifest,
    call(name, args, signal) {
      let input: unknown;
      try {
        authorize(signal);
        if (!catalog.has(name)) throw new ToolAccessError('This tool is not granted for the current invocation.');
        if (++calls > maxCalls) throw new ToolAccessError('The invocation reached its tool-call limit.');
        if (Buffer.byteLength(JSON.stringify(args) ?? '') > 65536) throw new ToolAccessError('Tool arguments exceeded the 64 KiB limit.');
        input = structuredClone(args);
      } catch (error) { return Promise.reject(error instanceof ToolAccessError ? error : new ToolAccessError('Invalid tool arguments.')); }
      deadline ??= AbortSignal.timeout(maxRuntimeMs);
      const combined = AbortSignal.any([signal, lifetime.signal, deadline]);
      // Serialize calls so command side effects and file reads have a defined order.
      const operation = previous.then(async (): Promise<ToolResult> => {
        authorize(combined);
        try {
          const result = await catalog.get(name)!.call(input, combined);
          authorize(combined);
          if (!result || !Array.isArray(result.content) || result.content.some(item => !item || item.type !== 'text' || typeof item.text !== 'string') || Buffer.byteLength(JSON.stringify(result)) > 131072) throw new BuiltinToolError('Tool result exceeded the 128 KiB limit or had an unsupported format.');
          return result;
        } catch (error) {
          authorize(combined);
          return { content: [{ type: 'text', text: error instanceof BuiltinToolError ? error.message : 'Tool execution failed. Check the saved connection, command, or worktree and try again.' }], isError: true };
        }
      });
      previous = operation.catch(() => {});
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    },
    async close() { closed = true; lifetime.abort(); await Promise.allSettled([...pending]); }
  };
}
