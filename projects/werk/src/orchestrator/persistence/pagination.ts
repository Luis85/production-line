import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { identifier, object } from '../../shared/contracts.js';
import type { Task } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import type { PageQuery, PaginationMetadata, TaskEvent, WorkerSummary } from '../../shared/protocol.js';

type Row = Record<string, SQLOutputValue>;
type CursorKind = 'tasks' | 'workers' | 'events';
interface Cursor {
  version: 1;
  kind: CursorKind;
  watermark: number;
  position?: number;
  created?: number;
  id?: string;
  taskId?: string;
}
const PAGE_BYTES = 4 * 1024 * 1024;

function pagination(query: PageQuery, kind: CursorKind, taskId?: string) {
  object(query, 'Pagination query', ['limit', 'cursor']);
  const limit = query.limit === undefined ? 100 : query.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new DomainError('invalid_input', 'Page limit: integer 1–1000');
  }
  if (query.cursor === undefined) return { limit, cursor: undefined };
  let cursor: Cursor;
  try {
    if (typeof query.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(query.cursor)) throw Error();
    const bytes = Buffer.from(query.cursor, 'base64url');
    if (bytes.toString('base64url') !== query.cursor) throw Error();
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const keys = kind === 'tasks' ? ['version', 'kind', 'watermark', 'created', 'id']
      : kind === 'events' ? ['version', 'kind', 'watermark', 'position', 'taskId']
      : ['version', 'kind', 'watermark', 'position'];
    const value = object(parsed, 'Cursor', keys);
    const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
    if (value.version !== 1 || value.kind !== kind || !integer(value.watermark)) throw Error();
    if (kind === 'tasks') {
      if (!integer(value.created) || identifier(value.id, 'id') !== value.id) throw Error();
    } else if (!integer(value.position) || value.position > value.watermark) throw Error();
    if (kind === 'events' && value.taskId !== taskId) throw Error();
    cursor = value as unknown as Cursor;
  } catch {
    throw new DomainError('invalid_input', 'Invalid cursor for this collection');
  }
  return { limit, cursor };
}

/** Bound both payload count and serialized bytes; a lookahead row determines continuation. */
function collectPage<T>(rows: Iterable<Row>, limit: number, decode: (row: Row) => T, cursor: (row: Row) => Cursor): { items: T[] } & PaginationMetadata {
  const items: T[] = [];
  let bytes = 0, last: Row | undefined, hasMore = false;
  for (const row of rows) {
    if (items.length === limit) { hasMore = true; break; }
    const item = decode(row);
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (size > PAGE_BYTES) throw new DomainError('internal', 'Stored record exceeds page response limit');
    if (bytes + size > PAGE_BYTES) { hasMore = true; break; }
    items.push(item); bytes += size; last = row;
  }
  return { items, hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify(cursor(last))).toString('base64url') : null };
}

export function taskPage(db: DatabaseSync, query: PageQuery, decode: (row: Row) => Task) {
  const { limit, cursor } = pagination(query, 'tasks');
  const watermark = cursor?.watermark ?? Number(db.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM tasks').get()!.value);
  const conditions = cursor ? ' AND created<=? AND (created<? OR id>?)' : '';
  const parameters = cursor ? [watermark, cursor.created!, cursor.created!, cursor.id!, limit + 1] : [watermark, limit + 1];
  const rows = db.prepare('SELECT * FROM tasks WHERE rowid<=?' + conditions + ' ORDER BY created DESC,id LIMIT ?').iterate(...parameters);
  const { items, ...metadata } = collectPage(rows, limit, decode, row => ({ version: 1, kind: 'tasks', watermark, created: Number(row.created), id: String(row.id) }));
  return { tasks: items, ...metadata };
}

export function workerPage(db: DatabaseSync, query: PageQuery, now: number, ttl: number) {
  const { limit, cursor } = pagination(query, 'workers');
  const watermark = cursor?.watermark ?? Number(db.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM workers').get()!.value);
  // Registration sequence is immutable; seen changes on every heartbeat and cannot be a safe cursor.
  const rows = db.prepare('SELECT rowid AS position,id,project,profiles,seen,config FROM workers WHERE rowid<=? AND rowid<? ORDER BY rowid DESC LIMIT ?')
    .iterate(watermark, cursor?.position ?? Number.MAX_SAFE_INTEGER, limit + 1);
  const { items, ...metadata } = collectPage<WorkerSummary>(rows, limit, row => ({
    id: String(row.id), project: String(row.project), profiles: JSON.parse(String(row.profiles)),
    seen: Number(row.seen), config: JSON.parse(String(row.config)), online: now - Number(row.seen) < ttl,
  }), row => ({ version: 1, kind: 'workers', watermark, position: Number(row.position) }));
  return { workers: items, ...metadata };
}

export function eventPage(db: DatabaseSync, taskId: string, query: PageQuery) {
  const { limit, cursor } = pagination(query, 'events', taskId);
  const watermark = cursor?.watermark ?? Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS value FROM events WHERE task=?').get(taskId)!.value);
  const rows = db.prepare('SELECT seq,kind,at,detail FROM events WHERE task=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?')
    .iterate(taskId, cursor?.position ?? 0, watermark, limit + 1);
  const { items, ...metadata } = collectPage<TaskEvent>(rows, limit, row => ({ seq: Number(row.seq), kind: String(row.kind), at: Number(row.at), detail: JSON.parse(String(row.detail)) }),
    row => ({ version: 1, kind: 'events', watermark, position: Number(row.seq), taskId }));
  return { events: items, ...metadata };
}
