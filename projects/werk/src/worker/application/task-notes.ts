import { createHash } from 'node:crypto';
import { Lexer, type Token, type Tokens } from 'marked';
import { isAlias, isMap, isScalar, isSeq, parseDocument, stringify, visit } from 'yaml';
import { DomainError } from '../../shared/errors.js';
import { identifier, object } from '../../shared/validation.js';
import type { InteractionCommand, InteractionView } from './interactions.js';

export interface TaskNoteIdentity {
  id: string;
  featureId: string;
  owner: string;
  sessionId: string;
  action: 'answer' | 'resume';
  pendingId: string | null;
  turnId: string;
  expectedRevision: number;
}
export interface TaskNote {
  identity: TaskNoteIdentity;
  status: 'draft' | 'open' | 'ready' | 'processed' | 'error';
  answer: string;
  error?: string;
  responseDigest?: string;
}
interface TaskNoteProjection {
  identity: TaskNoteIdentity;
  title: string;
  question: string;
  choices?: { id: string; label: string }[];
  reason?: string;
  answer?: string;
  status?: TaskNote['status'];
  error?: string;
  responseDigest?: string;
}
const identityFields = ['id', 'featureId', 'owner', 'sessionId', 'action', 'pendingId', 'turnId', 'expectedRevision'] as const;
const statuses = new Set<TaskNote['status']>(['draft', 'open', 'ready', 'processed', 'error']);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function invalid(message: string): never { throw new DomainError('invalid_input', message); }
const fingerprint = (identity: TaskNoteIdentity) => JSON.stringify(identityFields.map(key => identity[key]));
function exactId(value: unknown, name: string): string {
  const checked = identifier(value, name);
  if (checked !== value) invalid(`Task ${name} must not contain surrounding whitespace.`);
  return checked;
}
function identityValue(value: unknown): TaskNoteIdentity {
  const data = object(value, 'Task identity', identityFields);
  const action = data.action;
  if (action !== 'answer' && action !== 'resume') invalid('Task action must be answer or resume.');
  if (typeof data.expectedRevision !== 'number' || !Number.isSafeInteger(data.expectedRevision) || data.expectedRevision < 0)
    invalid('Task expectedRevision must be a nonnegative safe integer.');
  const pendingId = data.pendingId === null ? null : exactId(data.pendingId, 'pendingId');
  if ((action === 'answer') !== (pendingId !== null)) invalid('Only answer Tasks bind a pending question.');
  return {
    id: exactId(data.id, 'id'), featureId: exactId(data.featureId, 'featureId'), owner: exactId(data.owner, 'owner'),
    sessionId: exactId(data.sessionId, 'sessionId'), action, pendingId, turnId: exactId(data.turnId, 'turnId'), expectedRevision: data.expectedRevision,
  };
}
/** Derive a note from an actual checkpoint; cancelled/completed/active turns never become resumable Tasks. */
export function createTaskNoteIdentity(featureId: string, owner: string, view: InteractionView): TaskNoteIdentity | null {
  const pending = view.pending;
  let action: TaskNoteIdentity['action'], turnId: string;
  if (pending && ['waiting_input', 'escalated'].includes(view.phase)) {
    if (view.latestTurn?.id !== pending.turnId) invalid('The pending question does not belong to the latest interaction turn.');
    action = 'answer'; turnId = pending.turnId;
  } else if (!pending && ['failed', 'interrupted'].includes(view.phase) && view.latestTurn && view.latestTurn.status === view.phase) {
    action = 'resume'; turnId = view.latestTurn.id;
  } else return null;
  const identity = identityValue({ id: 'pending', featureId, owner, sessionId: view.sessionId, action, pendingId: pending?.id ?? null, turnId, expectedRevision: view.revision });
  identity.id = 'task-' + hash(fingerprint(identity)).slice(0, 40);
  return identity;
}
function bounded(value: unknown, name: string, maximum: number, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
    invalid(`Task ${name} must contain ${empty ? '0' : '1'}–${maximum} characters without control characters.`);
  return value;
}
function optionalDigest(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid('Task responseDigest must be a SHA-256 digest.');
  return value;
}
function noteStatus(value: unknown): TaskNote['status'] {
  if (typeof value !== 'string' || !statuses.has(value as TaskNote['status'])) invalid('Task status must be draft, open, ready, processed or error.');
  return value as TaskNote['status'];
}
function parse(markdown: string, expected: TaskNoteIdentity) {
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown) > 65536) invalid('Task note exceeds 64 KiB.');
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match || Buffer.byteLength(match[1]) > 16384) invalid('Task note needs bounded YAML frontmatter.');
  const document = parseDocument(match[1], { strict: true, uniqueKeys: true, customTags: [] });
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) invalid('Task frontmatter must be a valid mapping with unique keys.');
  let nodes = 0;
  visit(document, (_key, node, path) => {
    if (++nodes > 100 || path.length > 8 || isAlias(node) || (isScalar(node) || isMap(node) || isSeq(node)) && node.tag)
      invalid('Task frontmatter cannot contain aliases, tags or excessive nesting.');
    if (isMap(node)) for (const pair of node.items)
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(pair.key.value)) invalid('Task frontmatter keys must be safe strings.');
  });
  const data = object(document.toJS({ maxAliasCount: 0 }), 'Task frontmatter', ['schemaVersion', 'type', 'title', 'status', ...identityFields, 'error', 'responseDigest']);
  if (data.schemaVersion !== 1 || data.type !== 'Task') invalid('Use schemaVersion: 1 and type: Task.');
  bounded(data.title, 'title', 240);
  const identity = identityValue(Object.fromEntries(identityFields.map(key => [key, data[key]])));
  if (fingerprint(identity) !== fingerprint(identityValue(expected))) throw new DomainError('conflict', 'Task identity changed. Restore the original worker, feature, session, checkpoint and revision fields.');
  const note: TaskNote = {
    identity, status: noteStatus(data.status), answer: answerSection(markdown.slice(match[0].length)),
    ...(data.error === undefined ? {} : { error: bounded(data.error, 'error', 2000) }),
    ...(data.responseDigest === undefined ? {} : { responseDigest: optionalDigest(data.responseDigest) }),
  };
  return { document, note, body: markdown.slice(match[0].length), newline: markdown.includes('\r\n') ? '\r\n' : '\n' };
}
function answerSection(body: string): string {
  // Markdown tokens distinguish real top-level headings from fenced examples, quotes and HTML comments.
  const normalized = body.replace(/\r\n?/g, '\n');
  let offset = 0, start: number | undefined, end: number | undefined;
  for (const token of Lexer.lex(normalized)) {
    if (token.type === 'heading' && token.depth <= 2) {
      if (start !== undefined && end === undefined) end = offset;
      if (token.depth === 2 && token.text === 'Answer') {
        if (start !== undefined) invalid('Task note must contain exactly one top-level ## Answer section.');
        start = offset + token.raw.length;
      }
    }
    offset += token.raw.length;
  }
  if (start === undefined) invalid('Task note needs an editable ## Answer section.');
  return bounded(normalized.slice(start, end).trim(), 'answer', 8000, true);
}
/** Read against a trusted, durably saved identity, never metadata supplied by the editor alone. */
export function readTaskNote(markdown: string, expected: TaskNoteIdentity): TaskNote { return parse(markdown, expected).note; }

export function renderTaskNote(input: TaskNoteProjection): string {
  const identity = identityValue(input.identity);
  const title = bounded(input.title, 'title', 240).replace(/[\r\n]+/g, ' ');
  const question = bounded(input.question, 'question', 8000);
  const answer = bounded(input.answer ?? '', 'answer', 8000, true);
  const quote = (value: string) => value.replace(/\r\n?/g, '\n').split('\n').map(line => '> ' + line).join('\n');
  if (input.choices && input.choices.length > 20) invalid('Task choices must contain at most 20 options.');
  const choices = input.choices?.map(choice => '- ' + bounded(choice.label, 'choice label', 500).replace(/[\r\n]+/g, ' ') + ' (`' + exactId(choice.id, 'choice id') + '`)').join('\n');
  const metadata = {
    schemaVersion: 1, type: 'Task', title, status: noteStatus(input.status ?? 'open'), ...identity,
    ...(input.error === undefined ? {} : { error: bounded(input.error, 'error', 2000) }),
    ...(input.responseDigest === undefined ? {} : { responseDigest: optionalDigest(input.responseDigest) }),
  };
  const body = `# ${title}\n\n## ${identity.action === 'answer' ? 'Question' : 'Resume the stopped attempt'}\n\n${quote(question)}\n\n` +
    (choices ? `## Choices\n\n${choices}\n\n` : '') +
    (input.reason ? `## Why input is needed\n\n${quote(bounded(input.reason, 'reason', 4000))}\n\n` : '') +
    '## How to respond\n\nWrite your response below, then set `status: ready`. For shared Git intake, commit and push this note. The worker validates the saved checkpoint before continuing. This does not grant tools or approve a feature merge.\n\n' +
    `## Answer\n\n${answer || '<!-- Write your answer here. Keep the identity fields unchanged. -->'}\n`;
  const markdown = '---\n' + stringify(metadata, { lineWidth: 0 }) + '---\n' + body;
  readTaskNote(markdown, identity);
  return markdown;
}
function meaningful(token: Token): boolean {
  if (token.type === 'space') return false;
  if (token.type === 'html') return !!token.raw.replace(/<!--[\s\S]*?(?:-->|$)/g, '').trim();
  if (token.type === 'blockquote') return token.tokens?.some(meaningful) ?? false;
  if (token.type === 'list') return token.items.some((item: Tokens.ListItem) => item.tokens.some(meaningful));
  return true;
}
/** Existing interaction admission owns freshness, policy and duplicate-operation checks. */
export function taskNoteResponse(markdown: string, expected: TaskNoteIdentity): { command: InteractionCommand; responseDigest: string; note: TaskNote } | null {
  const note = readTaskNote(markdown, expected);
  if (note.status !== 'ready') return null;
  if (!Lexer.lex(note.answer).some(meaningful)) invalid('Write a nonempty answer before setting Task status to ready.');
  const responseDigest = hash(note.answer);
  const operationId = 'task-response-' + hash(fingerprint(note.identity) + '\n' + responseDigest);
  const { action, sessionId, expectedRevision, pendingId, turnId } = note.identity;
  const command: InteractionCommand = {
    action, sessionId, expectedRevision, operationId,
    ...(action === 'answer' ? { pendingId: pendingId!, answer: note.answer } : { turnId, message: note.answer }),
  };
  return { command, responseDigest, note };
}
/** Acknowledgement changes metadata only; operator text and line endings are retained byte for byte. */
export function markTaskNoteResponse(markdown: string, expected: TaskNoteIdentity, result: { status: 'processed' | 'error'; error?: string; responseDigest?: string }): string {
  const parsed = parse(markdown, expected);
  if (result.status !== 'processed' && result.status !== 'error') invalid('Worker acknowledgement must be processed or error.');
  const digest = optionalDigest(result.responseDigest);
  if (result.status === 'processed' && !digest || digest && digest !== hash(parsed.note.answer)) throw new DomainError('conflict', 'Task acknowledgement does not match this answer.');
  parsed.document.set('status', result.status);
  if (result.error === undefined) parsed.document.delete('error');
  else parsed.document.set('error', bounded(result.error, 'error', 2000));
  if (digest === undefined) parsed.document.delete('responseDigest'); else parsed.document.set('responseDigest', digest);
  return '---' + parsed.newline + parsed.document.toString({ lineWidth: 0 }).replace(/\r?\n/g, parsed.newline) + '---' + parsed.newline + parsed.body;
}
