import { callTimeout, formatToolDuration } from './tool-limits.js';
import { DomainError } from '../../shared/errors.js';

/**
 * A project command-line tool the model may call with its own arguments. The
 * operator fixes the executable and leading arguments; the model supplies the
 * rest, which must pass this argument policy before any process starts.
 */
export interface CliCommandRule {
  /** One or two literal leading tokens, such as `check` or `backlog context`. */
  command: string;
  /** When non-empty, one of these flags must directly follow the command, a value or another listed flag. */
  requireOneOf: string[];
  /** Options refused for this command in addition to the tool-wide list. */
  refusedOptions: string[];
}
export interface ToolCliTool {
  id: string; name: string; description: string; enabled: boolean;
  executable: string; args: string[];
  commands: CliCommandRule[]; refusedOptions: string[];
  maxArgs: number; maxArgLength: number; outputKiB: number; truncationHint: string;
  /** Optional narrower cap within the frozen invocation command limit. */ timeoutMs?: number;
}
export const cliToolLimits = Object.freeze({ tools: 8, rules: 64, options: 32, required: 8, maxArgs: 64, maxArgLength: 2048, outputKiB: 64, description: 8000 });
export const cliToolDefaults = Object.freeze({ maxArgs: 24, maxArgLength: 500, outputKiB: 32, truncationHint: 'Narrow the command, for example with a filter, limit or summary option.' });
/** Model-facing tool names stay within provider limits and never contain host paths. */
export const cliToolName = (id: string) => 'werk_cli_' + id;
export class CliArgumentError extends Error {}

function invalid(message: string): never { throw new DomainError('invalid_input', message); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const control = /[\x00-\x1f\x7f]/;
const optionPattern = /^-{1,2}[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const tokenPattern = /^(?:--?)?[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
function text(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || control.test(value)) invalid(`Use a valid ${label} (at most ${max} characters, no control characters).`);
  return value;
}
function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid(`${label} must be a whole number from ${min} to ${max}.`);
  return Number(value);
}
function options(value: unknown, label: string, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) invalid(`List at most ${max} ${label}.`);
  const result = value.map(item => { if (typeof item !== 'string' || !optionPattern.test(item)) invalid(`${label[0].toUpperCase() + label.slice(1)} are option names such as --dry-run or -o, without values.`); return item; });
  if (new Set(result).size !== result.length) invalid(`List each of the ${label} once.`);
  return result;
}
function fields(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid(`Use the documented ${label} fields: ${allowed.join(', ')}.`);
  return value;
}

/** Validate a stored or submitted CLI tool; optional limits receive documented defaults. */
export function validateCliTool(value: unknown, absolute: (value: unknown, label: string) => string): ToolCliTool {
  const input = fields(value, ['id', 'name', 'description', 'enabled', 'executable', 'args', 'commands', 'refusedOptions', 'maxArgs', 'maxArgLength', 'outputKiB', 'truncationHint', 'timeoutMs'], 'CLI tool');
  const id = text(input.id, 'CLI tool ID', 48);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) invalid('CLI tool IDs use 1–48 letters, digits, underscores and hyphens.');
  const executable = absolute(input.executable, 'CLI tool executable');
  // cmd.exe re-parses batch-file arguments, so model text could become shell syntax.
  if (/\.(?:bat|cmd)$/i.test(executable.trim())) invalid('CLI tools cannot run .bat or .cmd files, because Windows passes their arguments through cmd.exe. Use the interpreter executable, such as node.exe, with the script as a fixed argument.');
  if (!Array.isArray(input.args) || input.args.length > 32) invalid('Use at most 32 fixed CLI tool arguments.');
  const args = input.args.map(item => text(item, 'fixed CLI tool argument', 2048, true));
  const refusedOptions = options(input.refusedOptions, 'refused options', cliToolLimits.options);
  if (!Array.isArray(input.commands) || !input.commands.length || input.commands.length > cliToolLimits.rules) invalid(`Allow 1–${cliToolLimits.rules} commands for each CLI tool.`);
  const commands = input.commands.map(raw => {
    const rule = fields(raw, ['command', 'requireOneOf', 'refusedOptions'], 'CLI command rule');
    const command = text(rule.command, 'allowed command', 129).trim();
    const tokens = command.split(' ');
    if (tokens.length > 2 || tokens.some(token => !tokenPattern.test(token))) invalid(`Allowed commands are one or two words, such as "check" or "backlog context": "${command}" is not.`);
    if (tokens.some(token => refusedOptions.includes(token))) invalid(`Allowed command "${command}" uses a refused option.`);
    const requireOneOf = options(rule.requireOneOf, 'required flags', cliToolLimits.required);
    const ruleRefused = options(rule.refusedOptions, 'refused options', cliToolLimits.options);
    if (requireOneOf.some(flag => refusedOptions.includes(flag) || ruleRefused.includes(flag))) invalid(`Command "${command}" requires a flag that is also refused.`);
    return { command: tokens.join(' '), requireOneOf, refusedOptions: ruleRefused };
  });
  if (new Set(commands.map(item => item.command)).size !== commands.length) invalid('List each allowed CLI command once.');
  const timeoutMs = callTimeout(input.timeoutMs, `CLI tool "${id}"`);
  const tool: ToolCliTool = {
    id, name: text(input.name, 'CLI tool name', 120), description: text(input.description ?? '', 'CLI tool description', 1000, true), enabled: input.enabled === true ? true : input.enabled === false ? false : invalid('CLI tool enabled must be true or false.'),
    executable, args, commands, refusedOptions,
    maxArgs: integer(input.maxArgs, cliToolDefaults.maxArgs, 1, cliToolLimits.maxArgs, 'Maximum arguments'),
    maxArgLength: integer(input.maxArgLength, cliToolDefaults.maxArgLength, 1, cliToolLimits.maxArgLength, 'Maximum argument length'),
    outputKiB: integer(input.outputKiB, cliToolDefaults.outputKiB, 1, cliToolLimits.outputKiB, 'Output limit (KiB)'),
    truncationHint: text(input.truncationHint ?? cliToolDefaults.truncationHint, 'truncation hint', 300, true),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  if (cliToolDescription(tool).length > cliToolLimits.description) invalid(`The generated description for CLI tool "${id}" exceeds ${cliToolLimits.description} characters. Shorten its description or allow fewer commands.`);
  return tool;
}

const quoteList = (items: string[]) => items.map(item => `"${item}"`).join(', ');
/** Model-facing contract. It names commands and options only: no executable path or fixed argument. */
export function cliToolDescription(tool: ToolCliTool): string {
  const plain = tool.commands.filter(rule => !rule.requireOneOf.length).map(rule => rule.command);
  const guarded = tool.commands.filter(rule => rule.requireOneOf.length).map(rule => `"${rule.command}" with ${rule.requireOneOf.join(' or ')}`);
  const limited = tool.commands.filter(rule => rule.refusedOptions.length).map(rule => `"${rule.command}" refuses ${rule.refusedOptions.join(', ')}`);
  const example = JSON.stringify([...tool.commands[0].command.split(' '), ...tool.commands[0].requireOneOf.slice(0, 1)]);
  return [
    `[${tool.name}]${tool.description ? ' ' + tool.description : ''}`,
    `Runs an operator-approved command-line tool in the task worktree as the worker account, without a shell. Put the command first and pass every option and value as a separate string in "args", for example ${example}.`,
    plain.length ? `Allowed commands: ${quoteList(plain)}.` : '',
    guarded.length ? `Allowed only with a standalone required flag placed directly after the command, a value or another required flag (no assignments, negation, repetition or short-option clusters): ${guarded.join('; ')}.` : '',
    tool.refusedOptions.length ? `Refused options: ${tool.refusedOptions.join(', ')}.` : '',
    limited.length ? `${limited.join('; ')}.` : '',
    `Refused everywhere: absolute paths, "~", file: URLs, ".." path segments, @response files, the "--" terminator and control characters. At most ${tool.maxArgs} arguments of up to ${tool.maxArgLength} characters.`,
    `Returns the exit code, stdout and stderr, limited to ${tool.outputKiB} KiB. Output reflects the checked-out task worktree, not your proposed patch.`,
    tool.timeoutMs === undefined ? '' : `Additional per-call timeout cap: ${formatToolDuration(tool.timeoutMs)}; the invocation and command limits may stop it sooner.`,
  ].filter(Boolean).join(' ');
}
export function cliToolInputSchema(tool: ToolCliTool): Record<string, unknown> {
  return { type: 'object', properties: { args: { type: 'array', minItems: 1, maxItems: tool.maxArgs, items: { type: 'string', maxLength: tool.maxArgLength }, description: 'Command, then each option and value as a separate string.' } }, required: ['args'], additionalProperties: false };
}

/** Text that could name a location outside the worktree, checked as a whole and as an option value. */
function escapesWorktree(arg: string): boolean {
  const candidates = [arg];
  if (arg.startsWith('-') && arg.includes('=')) candidates.push(arg.slice(arg.indexOf('=') + 1));
  if (/^-[^-]/.test(arg)) candidates.push(arg.slice(2));
  // Response files can hide unchecked arguments even when their path is relative.
  // Check extracted option values too, including joined short values such as -I../outside.
  return candidates.some(value => /^(?:[\\/]|[a-zA-Z]:|~|file:|@)/i.test(value) || value.split(/[\\/=]/).some(part => part === '..'));
}

/** Accept the model's arguments or explain the refusal; never starts a process. */
export function checkCliArguments(tool: ToolCliTool, value: unknown): { args: string[]; rule: CliCommandRule } {
  if (!Array.isArray(value) || !value.length || value.length > tool.maxArgs) throw new CliArgumentError(`Pass "args" as 1–${tool.maxArgs} strings.`);
  const args = value.map(item => {
    if (typeof item !== 'string' || item.length > tool.maxArgLength || control.test(item)) throw new CliArgumentError(`Each argument must be a string of at most ${tool.maxArgLength} characters without control characters.`);
    return item;
  });
  if (args.includes('--')) throw new CliArgumentError('The "--" terminator is not available. Pass each value as its own argument instead.');
  const escaping = args.find(escapesWorktree);
  if (escaping !== undefined) throw new CliArgumentError(`Argument "${escaping.slice(0, 80)}" is refused: use paths relative to the task worktree, without "..", "~", drive letters, file: URLs or @response files.`);
  const rule = [...tool.commands].sort((a, b) => b.command.split(' ').length - a.command.split(' ').length)
    .find(item => item.command.split(' ').every((token, index) => args[index] === token));
  if (!rule) {
    const allowed = tool.commands.map(item => item.command);
    throw new CliArgumentError(`"${args.slice(0, 2).join(' ').slice(0, 80)}" is not an allowed command. Allowed: ${allowed.slice(0, 40).join(', ')}${allowed.length > 40 ? ', …' : ''}.`);
  }
  const width = rule.command.split(' ').length;
  const refused = [...tool.refusedOptions, ...rule.refusedOptions];
  const shortRefused = refused.filter(option => /^-[A-Za-z0-9]$/.test(option)).map(option => option[1]);
  for (const arg of args.slice(width)) {
    if (!arg.startsWith('-')) continue;
    const name = arg.split('=')[0];
    // A clustered short option such as -xo or -ofile may carry a refused letter.
    if (refused.includes(name) || (!arg.startsWith('--') && [...name.slice(1)].some(letter => shortRefused.includes(letter))))
      throw new CliArgumentError(`Option ${name.slice(0, 64)} is not available${rule.refusedOptions.includes(name) ? ` for "${rule.command}"` : ''}.`);
  }
  if (rule.requireOneOf.length) {
    const trailing = args.slice(width);
    for (const flag of rule.requireOneOf) {
      const opposite = flag.startsWith('--') ? (flag.startsWith('--no-') ? '--' + flag.slice(5) : '--no-' + flag.slice(2)) : undefined;
      const ambiguous = trailing.some(arg => {
        const name = arg.split('=')[0];
        return arg.startsWith(flag + '=') || name === opposite ||
          (/^-[A-Za-z0-9]$/.test(flag) && name.startsWith('-') && !name.startsWith('--') && name !== flag && name.slice(1).includes(flag[1]));
      });
      if (ambiguous || trailing.filter(arg => arg === flag).length > 1)
        throw new CliArgumentError(`"${rule.command}" is only available with unambiguous required flags: use ${flag} once as a standalone flag, without assignments, negation or short-option clusters.`);
    }
    // A flag after an option such as --title could be read as that option's value.
    const satisfied = args.some((arg, index) => index >= width && rule.requireOneOf.includes(arg) && (index === width || !args[index - 1].startsWith('-') || args[index - 1].includes('=') || rule.requireOneOf.includes(args[index - 1])));
    if (!satisfied) throw new CliArgumentError(`"${rule.command}" is only available with ${rule.requireOneOf.join(' or ')}, placed directly after the command, for example ${JSON.stringify([...rule.command.split(' '), rule.requireOneOf[0]])}.`);
  }
  return { args, rule };
}
