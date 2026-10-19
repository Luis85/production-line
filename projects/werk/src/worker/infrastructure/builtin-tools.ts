import { withOwnedResponse } from '../../shared/http/transport.js';
import { readResponseBody, ResponseBodyLimitError } from '../../shared/http/response-body.js';
import { runApprovedToolProcess } from './tool-process.js';
import { constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ProcessRunError } from '../../shared/process/launcher.js';
import { chatRepositoryId, type ToolChatDirectory, type ToolDefinition, type ToolPolicy } from '../application/tool-policy.js';
import { cliToolDescription, cliToolInputSchema, cliToolName } from '../application/cli-tool-policy.js';
import { CliToolError, runCliTool } from './cli-tools.js';
import { resolveCandidateReviewLimits, resolveToolLimits, formatToolDuration, type ResolvedToolLimits } from '../application/tool-limits.js';
import type { CandidateReviewLimits } from '../application/execution-policy.js';
import type { DevelopmentRuntime } from '../application/development.js';
import { CandidateToolError } from './candidate-tools.js';
import { candidateView } from './candidate-listing.js';
import type { ToolResult, ToolWorktreeIdentity } from '../application/tool-runtime.js';

export class BuiltinToolError extends Error {}
export interface ToolOperation { definition: ToolDefinition; /** Only the worker delegation broker may wait outside the shared side-effect queue. */ concurrent?: true; call(args: unknown, signal: AbortSignal): Promise<ToolResult>; }
/** Candidate review limits arrive frozen from the dispatch; absent values keep the 0.13 bounds. */
export interface BuiltinToolOptions extends Partial<CandidateReviewLimits> { policy: ToolPolicy; directory: string; worktree?: string; worktreeIdentity?: ToolWorktreeIdentity; development?: DevelopmentRuntime; commandTimeoutMs?: number; limits?: ResolvedToolLimits; fetch?: typeof globalThis.fetch; repositories?: () => readonly ToolRepository[]; }
/** A current worker repository assignment (settings `repositories.items`), never a path supplied by the model. */
export interface ToolRepository { id: string; path: string; }
const output = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const pathProperty = { type: 'string', maxLength: 1000, description: 'Relative path inside the task worktree. Defaults to its root.' };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new BuiltinToolError('Invalid tool arguments.');
  return value as Record<string, unknown>;
}
function number(value: unknown, fallback: number, maximum: number, minimum = 1): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new BuiltinToolError('Tool limit is out of range.');
  return Number(value);
}
function string(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value.includes('\0')) throw new BuiltinToolError('Invalid tool text argument.');
  return value;
}
function check(signal: AbortSignal) { if (signal.aborted) throw new BuiltinToolError('Tool execution was cancelled.'); }
function below(root: string, path: string) { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); }

/** Model-facing working-directory notes name repository IDs only, never host paths. */
export const chatWorkspaceNote = 'Chat: starts in an empty private workspace without project files.';
export const chatRepositoryNote = (repository: string) => `Chat: starts in the live checkout of assigned repository "${repository}".`;
export const chatWorkspaceHint = "In chat this grant starts in the worker's empty private chat workspace, which has no project files. A worker operator can set its chat directory to an assigned repository under Tool access.";

/**
 * Working directory for one chat call of a command preset or stdio MCP grant. Task invocations keep their pinned
 * worktree. A chat directory resolves only from the operator's grant and the assignments current at invocation
 * start; it is checked again before every call, so removing or moving the assignment revokes it.
 */
export function chatToolDirectory(options: Pick<BuiltinToolOptions, 'directory' | 'worktree' | 'repositories'>) {
  // Pin filesystem identity as well as the assignment: a replacement directory or symlink is a new grant target.
  const identity = (path: string) => {
    try {
      const info = lstatSync(path), canonical = realpathSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || canonical !== resolve(path)) return;
      return { canonical, dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
    } catch { return; }
  };
  const pinned = new Map((options.repositories?.() ?? []).map(item => [item.id, { path: item.path, identity: identity(item.path) }]));
  return async (grant: ToolChatDirectory): Promise<string> => {
    if (options.worktree) return options.worktree;
    const repository = chatRepositoryId(grant);
    if (repository === undefined) {
      const workspace = join(options.directory, 'chat-workspace');
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      return workspace;
    }
    const current = (options.repositories?.() ?? []).find(item => item.id === repository);
    if (!current) throw new BuiltinToolError(`Repository "${repository}" is no longer assigned to this worker, so this chat tool was not started. Ask the worker operator to update its chat directory under Tool access.`);
    const initial = pinned.get(repository);
    if (initial?.path !== current.path) throw new BuiltinToolError(`The assignment of repository "${repository}" changed during this reply, so this chat tool was not started. Send a new message to use the current assignment.`);
    const actual = identity(current.path);
    if (!initial.identity || !actual) throw new BuiltinToolError(`The checkout of assigned repository "${repository}" is unavailable or replaced, so this chat tool was not started.`);
    if (actual.canonical !== initial.identity.canonical || actual.dev !== initial.identity.dev || actual.ino !== initial.identity.ino || actual.birthtimeMs !== initial.identity.birthtimeMs)
      throw new BuiltinToolError(`The checkout of assigned repository "${repository}" changed during this reply, so this chat tool was not started. Send a new message after the operator reviews the assignment.`);
    return actual.canonical;
  };
}

/** Read-only worktree access deliberately excludes links and Git administrative files. */
class WorktreeReader {
  private readonly initial?: { path: string; dev: number; ino: number };
  private readonly root: string;
  constructor(root: string, expected?: ToolWorktreeIdentity) {
    this.root = root;
    try { const path = realpathSync(root), info = statSync(path); if (info.isDirectory() && path === resolve(root) && (!expected || String(info.dev) === expected.dev && String(info.ino) === expected.ino && info.birthtimeMs === expected.birthtimeMs)) this.initial = { path, dev: info.dev, ino: info.ino }; } catch { /* A missing or replaced worktree never grants access. */ }
  }
  async path(input: unknown, signal: AbortSignal) {
    check(signal);
    const value = input === undefined ? '.' : string(input, 1000);
    if (isAbsolute(value) || value.includes('\\') || value.includes(':') || value.split('/').some(part => part === '..' || part.toLowerCase() === '.git')) throw new BuiltinToolError('Only paths inside the task worktree are available; Git metadata and symbolic links are excluded.');
    const root = await realpath(this.root);
    const rootInfo = await lstat(root);
    if (!this.initial || root !== this.initial.path || rootInfo.dev !== this.initial.dev || rootInfo.ino !== this.initial.ino) throw new BuiltinToolError('The task worktree changed; start a new invocation.');
    const path = resolve(root, value);
    if (!below(root, path)) throw new BuiltinToolError('The requested path is outside the task worktree.');
    let current = root;
    for (const part of relative(root, path).split(sep).filter(Boolean)) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new BuiltinToolError('Symbolic links are excluded from file tools.');
    }
    const canonical = await realpath(path);
    if (!below(root, canonical) || canonical !== path) throw new BuiltinToolError('The requested path is outside the task worktree.');
    check(signal);
    return { root, path, relative: relative(root, path).split(sep).join('/') || '.' };
  }
  async bytes(input: unknown, signal: AbortSignal, offset = 0, limit = 32768) {
    const scoped = await this.path(input, signal);
    const before = await lstat(scoped.path);
    if (!before.isFile() || before.isSymbolicLink()) throw new BuiltinToolError('File tools read regular files only.');
    const handle = await open(scoped.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      // Verify the open descriptor still names the checked file, including a parent renamed during open.
      const after = await this.path(input, signal);
      const current = await lstat(after.path);
      if (after.root !== scoped.root || after.path !== scoped.path || !opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.dev !== current.dev || opened.ino !== current.ino) throw new BuiltinToolError('File changed during access; retry the tool.');
      const buffer = Buffer.alloc(limit + 4);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      check(signal);
      let end = Math.min(bytesRead, limit);
      // Never split a UTF-8 character when returning a continuation offset.
      if (bytesRead > limit) while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
      if (bytesRead && !end) throw new BuiltinToolError('The read limit is too small for the next UTF-8 character.');
      const bytes = buffer.subarray(0, end);
      if (bytes.includes(0)) throw new BuiltinToolError('Binary files are not available through file tools.');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new BuiltinToolError('Read valid UTF-8 files from a character boundary; binary files are excluded.'); }
      return { path: scoped.relative, text, offset, nextOffset: bytesRead > end ? offset + end : null };
    } finally { await handle.close(); }
  }
  async list(input: unknown, signal: AbortSignal, limit: number) {
    const scoped = await this.path(input, signal);
    const entries: { name: string; type: 'directory' | 'file' }[] = [];
    let truncated = false, inspected = 0;
    const directory = await opendir(scoped.path);
    for await (const item of directory) {
      check(signal);
      if (++inspected > 1000) { truncated = true; break; }
      if (item.name.toLowerCase() === '.git' || item.isSymbolicLink() || !item.isFile() && !item.isDirectory()) continue;
      if (entries.length >= limit) { truncated = true; break; }
      entries.push({ name: item.name, type: item.isDirectory() ? 'directory' : 'file' });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { path: scoped.relative, entries, truncated };
  }
  async search(input: unknown, query: string, signal: AbortSignal, limit: number) {
    const scoped = await this.path(input, signal);
    const pending = [{ path: scoped.relative, depth: 0 }];
    const matches: { path: string; line: number; text: string }[] = [];
    let inspected = 0, visited = 0, bytes = 0, truncated = false;
    while (pending.length) {
      check(signal);
      const next = pending.pop()!;
      if (++visited > 1000 || inspected >= 500 || bytes >= 2 * 1024 * 1024 || matches.length >= limit) { truncated = true; break; }
      let safe;
      try { safe = await this.path(next.path, signal); } catch { check(signal); continue; }
      const info = await lstat(safe.path);
      if (info.isDirectory()) {
        if (next.depth >= 12) { truncated = true; continue; }
        const listing = await this.list(next.path, signal, 500);
        truncated ||= listing.truncated;
        for (const entry of listing.entries) pending.push({ path: (next.path === '.' ? '' : next.path + '/') + entry.name, depth: next.depth + 1 });
      } else if (info.isFile()) {
        inspected++;
        if (info.size > 262144) { truncated = true; continue; }
        let content;
        try { content = await this.bytes(next.path, signal, 0, Math.min(262144, 2 * 1024 * 1024 - bytes)); } catch { check(signal); continue; }
        bytes += Buffer.byteLength(content.text);
        truncated ||= content.nextOffset !== null;
        const lines = content.text.split('\n');
        for (let index = 0; index < lines.length; index++) {
          const match = lines[index].indexOf(query);
          if (match === -1) continue;
          if (matches.length >= limit) { truncated = true; break; }
          matches.push({ path: content.path, line: index + 1, text: lines[index].slice(Math.max(0, match - 100), match + Math.min(query.length, 300) + 100) });
        }
      }
    }
    return { matches, inspectedFiles: inspected, truncated };
  }
}

export function builtinToolOperations(options: BuiltinToolOptions): ToolOperation[] {
  const limits = options.limits ?? resolveToolLimits(options.policy, { commandTimeoutMs: options.commandTimeoutMs });
  const result: ToolOperation[] = [];
  const add = (name: string, description: string, inputSchema: Record<string, unknown>, call: ToolOperation['call']) => result.push({ definition: { name, description, inputSchema }, call });
  if (options.policy.builtins.files && options.worktree) {
    const files = new WorktreeReader(options.worktree, options.worktreeIdentity);
    add('werk_files_list', 'List a directory in the assigned task worktree. Read-only; excludes symbolic links and Git metadata. A truncated listing is incomplete.', schema({ path: pathProperty, limit: { type: 'integer', minimum: 1, maximum: 200 } }), async (value, signal) => {
      const args = object(value, ['path', 'limit']); return output(await files.list(args.path, signal, number(args.limit, 100, 200)));
    });
    add('werk_files_read', 'Read up to 32768 UTF-8 bytes from a regular task-worktree file. Follow nextOffset for additional content. No binary files, links or Git metadata.', schema({ path: pathProperty, offset: { type: 'integer', minimum: 0, maximum: 1073741824 }, limit: { type: 'integer', minimum: 1, maximum: 32768 } }, ['path']), async (value, signal) => {
      const args = object(value, ['path', 'offset', 'limit']); string(args.path, 1000); return output(await files.bytes(args.path, signal, number(args.offset, 0, 1073741824, 0), number(args.limit, 32768, 32768)));
    });
    add('werk_files_search', 'Find a literal, case-sensitive string in task-worktree text files. Bounded to 500 files, 1000 entries, 2 MiB and 12 directory levels; truncated results are incomplete.', schema({ path: pathProperty, query: { type: 'string', minLength: 1, maxLength: 1000 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['query']), async (value, signal) => {
      const args = object(value, ['path', 'query', 'limit']); return output(await files.search(args.path, string(args.query, 1000), signal, number(args.limit, 50, 100)));
    });
  }
  if (options.development && options.policy.builtins.files && options.worktree) {
    const development = options.development;
    const candidateCall = (call: ToolOperation['call']): ToolOperation['call'] => async (value, signal) => {
      try { return await call(value, signal); } catch (error) { if (error instanceof CandidateToolError) throw new BuiltinToolError(error.message); throw error; }
    };
    add('werk_candidate_status', 'Inspect the current candidate and its required verification receipts. Returns approved file hashes for safe edits in a bounded listing: exact approved files, changed files (marked changed) and up to 200 other files below approved folders. When filesNote is present the listing is incomplete; pass paths for specific files. A changed candidate invalidates earlier successful checks. Requests from shared intake also return sharedPublication: the shared Git publication bounds (patch bytes, changed files), the candidate measurements and an error when it exceeds them; such a candidate fails every required check.', schema({ paths: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 240 }, description: 'Optional approved paths whose current hashes to include, for example unlisted files below an approved folder.' } }), candidateCall(async (value, signal) => {
      const args = object(value, ['paths']);
      if (args.paths !== undefined && (!Array.isArray(args.paths) || args.paths.length > 32 || args.paths.some(path => typeof path !== 'string'))) throw new BuiltinToolError('Supply at most 32 approved paths.');
      const candidate = await development.capture(signal, args.paths as string[] | undefined);
      // Evidence changed paths repeat the candidate's; the bounded listing above replaces them.
      const { schemaVersion, candidateDigest, checks, updatedAt } = development.evidence();
      return output({ ...candidateView(candidate), evidence: { schemaVersion, candidateDigest, updatedAt, checks: checks.map(check => ({ ...check, stdout: check.stdout.slice(0, 512), stderr: check.stderr.slice(0, 512), truncated: check.truncated || check.stdout.length > 512 || check.stderr.length > 512 })) } });
    }));
    add('werk_candidate_apply', 'Apply one change to an explicitly approved candidate file in the pinned worktree. Use its current hash from werk_candidate_status; null hash means the file must not exist. Content null deletes the file. Paths that Git ignores below an approved folder are refused. Returns the same bounded listing as werk_candidate_status. Every edit invalidates earlier checks; repository checkout and unapproved paths are untouched.', schema({ path: { type: 'string', maxLength: 240 }, content: { type: ['string', 'null'], maxLength: resolveCandidateReviewLimits(options).candidateApprovedFileMaxBytes, description: `New UTF-8 file content of at most ${resolveCandidateReviewLimits(options).candidateApprovedFileMaxBytes} bytes; characters outside ASCII use 2–4 bytes each. Null deletes the file.` }, expectedHash: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' } }, ['path', 'content', 'expectedHash']), candidateCall(async (value, signal) => {
      const args = object(value, ['path', 'content', 'expectedHash']);
      if (typeof args.path !== 'string' || args.content !== null && typeof args.content !== 'string' || args.expectedHash !== null && typeof args.expectedHash !== 'string') throw new BuiltinToolError('Supply an approved path, content or null, and the current expectedHash.');
      return output(await development.apply({ path: args.path, content: args.content as string | null, expectedHash: args.expectedHash as string | null }, signal));
    }));
    add('werk_candidate_check', 'Run one frozen required verification command against the actual candidate worktree. Use the preset ID from the task verification plan. A check only passes when exit code is zero and candidate source is unchanged; all required checks must pass after the final edit.', schema({ preset: { type: 'string', maxLength: 64 } }, ['preset']), candidateCall(async (value, signal) => {
      const args = object(value, ['preset']); const receipt = await development.check(string(args.preset, 64), signal);
      return { ...output(receipt), ...(receipt.status === 'passed' ? {} : { isError: true }) };
    }));
  }
  const commands = options.policy.builtins.commands.filter(command => command.enabled);
  const directory = chatToolDirectory(options), chat = !options.worktree;
  // Task manifests and results keep their 0.9.0 form; in chat the model learns where each preset starts.
  const where = (command: ToolChatDirectory) => { const repository = chatRepositoryId(command); return repository === undefined ? 'private chat workspace, no project files' : `live checkout of repository "${repository}"`; };
  if (commands.length) add('werk_command_run', chat
    ? 'Run one operator-approved executable with its fixed arguments, as the worker account. In chat a preset starts in the empty private chat workspace, which has no project files, unless its entry names an assigned repository checkout. Commands may change files or access resources outside that directory. No extra arguments or shell expansion.'
    : 'Run one operator-approved executable with its fixed arguments, as the worker account. Starts in the task worktree or private chat workspace. Commands may change files or access resources outside that directory. No extra arguments or shell expansion.', schema({ preset: { type: 'string', enum: commands.map(command => command.id), description: commands.map(command => `${command.id}: ${command.name}${chat ? ` (${where(command)})` : ''}${command.timeoutMs === undefined ? '' : ` (additional timeout cap ${formatToolDuration(command.timeoutMs)}; invocation limits may stop sooner)`}`).join('; ') } }, ['preset']), async (value, signal) => {
    const args = object(value, ['preset']); const preset = commands.find(command => command.id === args.preset);
    if (!preset) throw new BuiltinToolError('That command preset is not granted.');
    // A required check has one receipt regardless of the broker tool name used.
    if (options.development && preset.verification) {
      try {
        const receipt = await options.development.check(preset.id, signal);
        return { ...output({ preset: preset.id, ...receipt }), ...(receipt.status === 'passed' ? {} : { isError: true }) };
      } catch (error) { if (error instanceof CandidateToolError) throw new BuiltinToolError(error.message); throw error; }
    }
    const cwd = await directory(preset);
    const workspace = chat && chatRepositoryId(preset) === undefined, hint = workspace ? ' ' + chatWorkspaceHint : '';
    check(signal);
    try {
      const command = await runApprovedToolProcess(preset.executable, preset.args, { cwd, signal, timeoutMs: limits.presetTimeoutMs[preset.id], maxOutputBytes: 32768 });
      return output({ preset: preset.id, exitCode: command.exitCode, stdout: command.stdout.toString('utf8'), stderr: command.stderr.toString('utf8'), ...(chat ? { workingDirectory: where(preset) } : {}), ...(workspace && command.exitCode !== 0 ? { hint: chatWorkspaceHint } : {}) });
    } catch (error) {
      if (error instanceof ProcessRunError) throw new BuiltinToolError(`Command stopped (${error.reason}); no automatic retry was made.${hint}`);
      throw new BuiltinToolError(`Command could not be started. Check its executable and working directory.${hint}`);
    }
  });
  // CLI tools resolve relative fixed arguments such as bin/tool.mjs against a project, so chat without a worktree has none.
  const worktree = options.worktree;
  if (worktree) for (const tool of options.policy.builtins.cliTools.filter(item => item.enabled)) add(cliToolName(tool.id), cliToolDescription(tool), cliToolInputSchema(tool), async (value, signal) => {
    const args = object(value, ['args']);
    try { const result = await runCliTool(tool, args.args, worktree, signal, limits.cliTimeoutMs[tool.id]); return { content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) }; }
    catch (error) { if (error instanceof CliToolError) throw new BuiltinToolError(error.message); throw error; }
  });
  if (options.policy.builtins.webOrigins.length) add('werk_web_fetch', 'GET a public HTTP(S) URL on an operator-approved origin, without credentials or cookies. Redirects must also stay on approved origins. Returns at most 64 KiB.', schema({ url: { type: 'string', minLength: 1, maxLength: 4000 } }, ['url']), async (value, signal) => {
    const args = object(value, ['url']); const input = string(args.url, 4000);
    const allowed = new Set(options.policy.builtins.webOrigins);
    const validate = (value: string, base?: URL) => {
      let url; try { url = new URL(value, base); } catch { throw new BuiltinToolError('Invalid web URL.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !allowed.has(url.origin)) throw new BuiltinToolError('The web URL origin is not granted.');
      return url;
    };
    let url = validate(input);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(limits.webTimeoutMs)]);
    for (let redirects = 0; redirects <= 3; redirects++) {
      check(deadline);
      const result = await withOwnedResponse(url, { method: 'GET', redirect: 'manual', credentials: 'omit', headers: { Accept: 'text/*, application/json, application/xml' }, signal: deadline }, undefined, async response => {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          if (redirects === 3 || !response.headers.get('location')) throw new BuiltinToolError('Web redirect limit reached or redirect was invalid.');
          url = validate(response.headers.get('location')!, url); return undefined;
        }
        if (!response.ok) { await response.body?.cancel(); return output({ url: url.href, status: response.status, text: '' }); }
        let body: Uint8Array;
        try { body = await readResponseBody(response.body, 65536, { cancel: 'always' }); }
        catch (error) {
          if (error instanceof ResponseBodyLimitError) throw new BuiltinToolError('Web response exceeded the 64 KiB limit.');
          throw error;
        }
        check(deadline);
        if (body.includes(0)) throw new BuiltinToolError('Binary web responses are not available through this tool.');
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { throw new BuiltinToolError('Only UTF-8 text web responses are supported.'); }
        return output({ url: url.href, status: response.status, text });
      }, true, options.fetch);
      if (result !== undefined) return result;
    }
    throw new BuiltinToolError('Web redirect limit reached.');
  });
  return result;
}
