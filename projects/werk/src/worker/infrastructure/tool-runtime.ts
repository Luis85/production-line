import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { chatRepositoryId, type ToolPolicy } from '../application/tool-policy.js';
import type { DevelopmentRuntime } from '../application/development.js';
import { resolveToolLimits, type ResolvedToolLimits } from '../application/tool-limits.js';
import { cliToolName } from '../application/cli-tool-policy.js';
import { ToolAccessError, type ToolBudgetEvidence, type ToolManifest, type ToolResult, type ToolRuntime, type ToolWorktreeIdentity } from '../application/tool-runtime.js';
import { builtinToolOperations, BuiltinToolError, chatRepositoryNote, chatToolDirectory, chatWorkspaceHint, chatWorkspaceNote, type ToolOperation, type ToolRepository } from './builtin-tools.js';
import { callMcpTool, mcpTransportConfiguration } from './tool-mcp.js';

export interface ToolRuntimeOptions {
  policy: ToolPolicy;
  currentRevision: () => number;
  /** Private worker state directory. Chat commands start in its chat-workspace child unless a grant opts in to a repository. */
  directory: string;
  /** An approved, worker-owned task worktree, never a path supplied by the model. */
  worktree?: string;
  worktreeIdentity?: ToolWorktreeIdentity;
  development?: DevelopmentRuntime;
  maxCalls?: number;
  maxRuntimeMs?: number;
  commandTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /** Current repository assignments. Only grants with an operator-set chat directory use them, and only in chat. */
  repositories?: () => readonly ToolRepository[];
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

/** Deadline evidence names only exposed tools; grant IDs and numbers disclose no private command configuration. */
function manifestLimits(policy: ToolPolicy, names: string[], mcp: Map<string, number>, limits: ResolvedToolLimits): NonNullable<ToolManifest['limits']> {
  const callTimeoutMs: Record<string, number> = {};
  const commands = policy.builtins.commands.filter(item => item.enabled);
  for (const name of names) {
    if (name === 'werk_command_run') callTimeoutMs[name] = Math.max(...commands.map(item => limits.presetTimeoutMs[item.id]));
    else if (name === 'werk_candidate_check' && commands.some(item => item.verification)) callTimeoutMs[name] = Math.max(...commands.filter(item => item.verification).map(item => limits.presetTimeoutMs[item.id]));
    else if (name === 'werk_web_fetch') callTimeoutMs[name] = limits.webTimeoutMs;
    else if (mcp.has(name)) callTimeoutMs[name] = mcp.get(name)!;
    else { const tool = (policy.builtins.cliTools ?? []).find(item => item.enabled && cliToolName(item.id) === name); if (tool) callTimeoutMs[name] = limits.cliTimeoutMs[tool.id]; }
  }
  return { maxCalls: limits.maxCalls, windowMs: limits.maxRuntimeMs, callTimeoutMs,
    ...(names.includes('werk_command_run') ? { presetTimeoutMs: { ...limits.presetTimeoutMs } } : {}) };
}
const windowText = (ms: number) => ms >= 1000 ? `${Math.floor(ms / 1000)} s` : `${ms} ms`;
const remainingText = (ms: number) => ms >= 1000 ? `${Math.floor(ms / 1000)} s` : 'less than 1 s';
const callText = (count: number) => `${count} ${count === 1 ? 'call' : 'calls'}`;
const finish = 'Finish with the information you have, or ask the operator with a werkInteraction question.';
/**
 * Budget note appended as its own text item once a quarter or less of the calls or of the tool
 * window remains. Earlier results stay unchanged. The text holds counts and durations only.
 */
export function toolBudgetNote(remainingCalls: number, maxCalls: number, remainingMs: number, windowMs: number): string | undefined {
  if (remainingCalls <= 0) return `Tool budget: 0 of ${callText(maxCalls)} remain in this invocation. No further tool calls will run. ${finish}`;
  if (remainingCalls * 4 > maxCalls && remainingMs * 4 > windowMs) return;
  return `Tool budget: ${remainingCalls} of ${callText(maxCalls)} and ${remainingText(Math.max(0, remainingMs))} of the ${windowText(windowMs)} tool window remain.`;
}
/** Model-facing refusal for budget exhaustion. It is a normal tool error, never a lost tool. */
export function toolBudgetMessage(reason: ToolBudgetEvidence['reason'], maxCalls: number, windowMs: number, callsUsed: number, inFlight = false): string {
  const limits = `${callText(maxCalls)} / ${windowText(windowMs)} window`;
  const cause = inFlight ? `the ${windowText(windowMs)} tool window ended while this call was running, so it was stopped and its result is unavailable`
    : reason === 'calls' ? `the ${maxCalls}-call limit of this invocation is reached`
    : `the ${windowText(windowMs)} tool window of this invocation ended after ${callsUsed} of ${callText(maxCalls)}`;
  return `Tool budget exhausted (${limits}): ${cause}. No further tool calls will run in this invocation. ${finish}`;
}

/** No processes or network sessions are created until the model invokes a granted tool. */
export function createToolRuntime(options: ToolRuntimeOptions): ToolRuntime {
  const policy = structuredClone(options.policy);
  const pinnedWorktree = options.worktreeIdentity ? { ...options.worktreeIdentity } : undefined;
  const resolved = resolveToolLimits(policy, options);
  const { maxCalls, maxRuntimeMs, commandTimeoutMs } = resolved;
  const operations: ToolOperation[] = builtinToolOperations({ ...options, policy, commandTimeoutMs, limits: resolved });
  const mcpTimeouts = new Map<string, number>();
  const directoryFor = chatToolDirectory(options);
  // Names that receive the chat-workspace hint when they fail; task invocations and HTTP servers have no such hint.
  const workspaceTools = new Set<string>();
  for (const connection of policy.mcp.filter(item => item.enabled)) {
    const granted = connection.discoveredTools.filter(tool => connection.allowedTools.includes(tool.name));
    for (const tool of granted) mcpTimeouts.set(mcpToolName(connection.id, tool.name), resolved.mcpTimeoutMs[connection.id]);
    const repository = chatRepositoryId(connection);
    const note = options.worktree || connection.transport !== 'stdio' ? '' : ' (' + (repository === undefined ? chatWorkspaceNote : chatRepositoryNote(repository)) + ')';
    for (const tool of granted) {
      const name = mcpToolName(connection.id, tool.name);
      if (note && repository === undefined) workspaceTools.add(name);
      operations.push({
        definition: { ...tool, name, description: `[${connection.name}] ${tool.description}${note}` },
        call: async (args, signal) => {
          const directory = await directoryFor(connection);
          const result = await callMcpTool(mcpTransportConfiguration(connection), tool.name, args, granted, { signal, directory, timeoutMs: resolved.mcpTimeoutMs[connection.id] });
          // A server reporting an error from the empty chat workspace often expected project files.
          return result.isError && workspaceTools.has(name) ? { ...result, content: [...result.content, { type: 'text', text: chatWorkspaceHint }] } : result;
        }
      });
    }
  }
  if (operations.length > 64) throw new ToolAccessError('At most 64 tools may be granted for one invocation.');
  const catalog = new Map(operations.map(operation => [operation.definition.name, operation]));
  if (catalog.size !== operations.length) throw new ToolAccessError('Tool names are not unique.');
  const manifest: ToolManifest = freeze({ revision: policy.revision, tools: structuredClone(operations.map(operation => operation.definition)), limits: manifestLimits(policy, operations.map(operation => operation.definition.name), mcpTimeouts, resolved) });
  const lifetime = new AbortController();
  const pending = new Set<Promise<ToolResult>>();
  let calls = 0, refused = 0, startedAt = 0, deadline: AbortSignal | undefined, closed = false, exhausted: ToolBudgetEvidence['reason'] | undefined;
  let previous: Promise<unknown> = Promise.resolve();
  const grants = () => {
    let revision; try { revision = options.currentRevision(); } catch { throw new ToolAccessError(); }
    if (revision !== policy.revision) throw new ToolAccessError('Tool permissions changed. Start a new invocation to use the current grants.');
    if (options.worktree && pinnedWorktree) {
      try {
        const info = lstatSync(options.worktree);
        if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(options.worktree) !== resolve(options.worktree) || String(info.dev) !== pinnedWorktree.dev || String(info.ino) !== pinnedWorktree.ino || info.birthtimeMs !== pinnedWorktree.birthtimeMs) throw Error('Identity changed');
      } catch { throw new ToolAccessError('The retained task worktree changed. Create a new task before using its tools.'); }
    }
  };
  const authorize = (signal: AbortSignal) => {
    if (closed || signal.aborted) throw new ToolAccessError('Tool execution was cancelled or its invocation ended.');
    grants();
  };
  // Only the shared tool window ended: cancellation, revocation and invocation end still reject.
  const windowEnded = (signal: AbortSignal) => !!deadline?.aborted && !closed && !signal.aborted && !lifetime.signal.aborted;
  const refuse = (reason: ToolBudgetEvidence['reason'], inFlight = false): ToolResult => {
    refused++; exhausted ??= reason;
    return { content: [{ type: 'text', text: toolBudgetMessage(reason, maxCalls, maxRuntimeMs, calls, inFlight) }], isError: true };
  };
  // A separate text item keeps structured (JSON) tool output parseable and the 128 KiB check on the tool's own output.
  const noted = (result: ToolResult): ToolResult => {
    const note = toolBudgetNote(maxCalls - calls, maxCalls, maxRuntimeMs - (Date.now() - startedAt), maxRuntimeMs);
    return note ? { ...result, content: [...result.content, { type: 'text', text: note }] } : result;
  };
  return {
    manifest,
    limits: Object.freeze({ maxCalls, maxRuntimeMs, commandTimeoutMs }),
    budget: () => ({ maxCalls, windowMs: maxRuntimeMs, callsUsed: calls, refusedCalls: refused, exhausted: exhausted ? { reason: exhausted, maxCalls, windowMs: maxRuntimeMs, callsUsed: calls, refusedCalls: refused } : null }),
    call(name, args, signal) {
      let input: unknown;
      try {
        authorize(signal);
        if (!catalog.has(name)) throw new ToolAccessError('This tool is not granted for the current invocation.');
        if (deadline?.aborted) return Promise.resolve(refuse('window'));
        if (calls >= maxCalls) return Promise.resolve(refuse('calls'));
        calls++;
        if (Buffer.byteLength(JSON.stringify(args) ?? '') > 65536) throw new ToolAccessError('Tool arguments exceeded the 64 KiB limit.');
        input = structuredClone(args);
      } catch (error) { return Promise.reject(error instanceof ToolAccessError ? error : new ToolAccessError('Invalid tool arguments.')); }
      if (!deadline) { startedAt = Date.now(); deadline = AbortSignal.timeout(maxRuntimeMs); }
      const combined = AbortSignal.any([signal, lifetime.signal, deadline]);
      // Serialize calls so command side effects and file reads have a defined order.
      const operation = previous.then(async (): Promise<ToolResult> => {
        if (windowEnded(signal)) { grants(); return refuse('window'); }
        authorize(combined);
        try {
          const result = await catalog.get(name)!.call(input, combined);
          if (windowEnded(signal)) { grants(); return refuse('window', true); }
          authorize(combined);
          if (!result || !Array.isArray(result.content) || result.content.some(item => !item || item.type !== 'text' || typeof item.text !== 'string') || Buffer.byteLength(JSON.stringify(result)) > 131072) throw new BuiltinToolError('Tool result exceeded the 128 KiB limit or had an unsupported format.');
          return noted(result);
        } catch (error) {
          if (windowEnded(signal)) { grants(); return refuse('window', true); }
          authorize(combined);
          const text = error instanceof BuiltinToolError ? error.message : 'Tool execution failed. Check the saved connection, command, or worktree and try again.' + (workspaceTools.has(name) ? ' ' + chatWorkspaceHint : '');
          return noted({ content: [{ type: 'text', text }], isError: true });
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
