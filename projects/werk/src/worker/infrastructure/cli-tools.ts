import { runApprovedToolProcess } from './tool-process.js';
import { ProcessRunError, type RunResult } from '../../shared/process/launcher.js';
import { checkCliArguments, CliArgumentError, type ToolCliTool } from '../application/cli-tool-policy.js';
import { resolveCommandTimeoutMs } from '../application/tool-limits.js';

/** Messages are worker-owned and safe to return to the model. */
export class CliToolError extends Error {}
/** Output beyond this stops the process; the returned text is cut to the tool's own limit. */
const CAPTURE_BYTES = 1024 * 1024;
/** Leaves room for escaping inside the runtime's 128 KiB result limit. */
const ENCODED_BUDGET = 120 * 1024;

function clip(text: string, bytes: number): { text: string; cut: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= bytes) return { text, cut: false };
  let end = Math.max(0, bytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return { text: buffer.subarray(0, end).toString('utf8'), cut: true };
}
function readable(buffer: Buffer): string {
  return buffer.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
function report(tool: ToolCliTool, result: RunResult, stopped: string): string {
  const stdout = readable(result.stdout), stderr = readable(result.stderr);
  const limit = tool.outputKiB * 1024;
  const stderrBudget = Math.min(Buffer.byteLength(stderr), Math.floor(limit / 4));
  let out = clip(stdout, limit - stderrBudget), err = clip(stderr, stderrBudget);
  const compose = () => [`exit: ${result.exitCode ?? 'stopped'}`, out.text, ...(err.text ? ['[stderr]', err.text] : []),
    ...(out.cut || err.cut ? [`[output truncated at ${tool.outputKiB} KiB. ${tool.truncationHint}]`] : []), ...(stopped ? [`[${stopped}]`] : [])].join('\n');
  let text = compose();
  // Quote-heavy output can double when encoded; shrink until it fits.
  while (Buffer.byteLength(JSON.stringify(text)) > ENCODED_BUDGET) {
    out = { text: clip(out.text, Math.floor(Buffer.byteLength(out.text) * 0.75)).text, cut: true };
    err = { text: clip(err.text, Math.floor(Buffer.byteLength(err.text) * 0.75)).text, cut: err.cut || !!err.text };
    text = compose();
  }
  return text;
}

/**
 * Run an operator-approved CLI with model arguments that passed the tool's argument
 * policy. No shell is involved; the process starts in the task worktree with a
 * minimal environment, a deadline and contained process-tree cancellation.
 */
export async function runCliTool(tool: ToolCliTool, value: unknown, cwd: string, signal: AbortSignal, commandTimeoutMs?: number): Promise<{ text: string; isError: boolean }> {
  const timeoutMs = resolveCommandTimeoutMs(commandTimeoutMs, tool.timeoutMs);
  let args: string[];
  try { ({ args } = checkCliArguments(tool, value)); }
  catch (error) { if (error instanceof CliArgumentError) throw new CliToolError(error.message); throw error; }
  if (signal.aborted) throw new CliToolError('Tool execution was cancelled.');
  try {
    const result = await runApprovedToolProcess(tool.executable, [...tool.args, ...args], { cwd, signal, timeoutMs, maxOutputBytes: CAPTURE_BYTES, disableColor: true });
    return { text: report(tool, result, ''), isError: false };
  } catch (error) {
    if (!(error instanceof ProcessRunError) || error.reason === 'spawn') throw new CliToolError('The CLI tool could not be started. Check its executable, fixed arguments and the task worktree.');
    if (error.reason === 'cancelled') throw new CliToolError('Tool execution was cancelled.');
    // Partial output helps the model narrow the next call; no automatic retry is made.
    const stopped = error.reason === 'timeout' ? `stopped after ${timeoutMs / 1000} seconds; no automatic retry was made` : 'stopped after producing more than 1 MiB of output';
    return { text: report(tool, error.result, stopped), isError: error.reason === 'timeout' };
  }
}
