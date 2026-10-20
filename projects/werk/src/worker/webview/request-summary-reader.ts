import type { RequestSummary } from '../application/request-gates';
type SummaryPage = { schemaVersion: 1; rows: RequestSummary[]; total: number; nextOffset: number | null };
/** Read every summary page so overview counts never depend on an arbitrary first-page limit. */
export async function readRequestSummaries(read: <T>(path: string, method?: string, body?: unknown) => Promise<T>): Promise<RequestSummary[]> {
  const rows = new Map<string, RequestSummary>();
  let offset = 0;
  for (;;) {
    const page = await read<SummaryPage>('/api/requests', 'POST', { action: 'list', limit: 100, offset });
    if (!Array.isArray(page.rows)) throw new Error('Request summaries are unavailable. Refresh the worker to retry.');
    for (const row of page.rows) rows.set(row.id, row);
    if (page.nextOffset === null) return [...rows.values()];
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)
      throw new Error('The request summary cursor did not advance. Refresh the worker to retry.');
    offset = page.nextOffset;
  }
}
