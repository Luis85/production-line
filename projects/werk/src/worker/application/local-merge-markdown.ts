import type { LocalMergeState, LocalMergeReceipt } from './local-merge-contracts.js';
export interface LocalMergeProjection {
  operations: { operationId: string; status: string; detail: string }[];
  merged?: LocalMergeReceipt;
}
/** Canonical progress excludes private checkout paths and executable authority. */
export function localMergeProjection(state: LocalMergeState | undefined): LocalMergeProjection {
  return { operations: (state?.operations ?? []).map(({ operationId, status, detail }) => ({ operationId, status, detail })),
    ...(state?.merged ? { merged: { mergeCommit: state.merged.mergeCommit, tree: state.merged.tree, branch: state.merged.branch, previousHead: state.merged.previousHead, candidateCommit: state.merged.candidateCommit, mergedAt: state.merged.mergedAt } } : {}) };
}
export function localMergeMarkdown(state: LocalMergeProjection): string {
  const merge = state.merged;
  return '## Main checkout integration\n\n' + (merge
    ? `Confirmed merge: ${merge.mergeCommit}\nBranch: ${merge.branch}\nPrevious main head: ${merge.previousHead}\nReviewed candidate: ${merge.candidateCommit}\n`
    : 'Main checkout merge: not confirmed. Human acceptance and explicit checkout approval remain separate.\n') +
    state.operations.map(operation => `- ${operation.operationId}: ${operation.status} — ${operation.detail.replace(/[\r\n]+/g, ' ')}`).join('\n');
}

/** Repository-authored presentation is untrusted; malformed receipts never render. */
export function validLocalMergeProjection(value: unknown): value is LocalMergeProjection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['operations', 'merged'].includes(key)) || !Array.isArray(record.operations) || record.operations.length > 32) return false;
  if (!record.operations.every(item => item && typeof item === 'object' && !Array.isArray(item) &&
    Object.keys(item).every(key => ['operationId', 'status', 'detail'].includes(key)) &&
    typeof item.operationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(item.operationId) &&
    ['pending', 'unknown', 'confirmed', 'not_observed', 'failed'].includes(item.status) && typeof item.detail === 'string' && item.detail.length <= 4000)) return false;
  if (record.merged === undefined) return true;
  if (!record.merged || typeof record.merged !== 'object' || Array.isArray(record.merged)) return false;
  const merge = record.merged as Record<string, unknown>;
  const commit = (key: string) => typeof merge[key] === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(merge[key]);
  return Object.keys(merge).every(key => ['mergeCommit', 'tree', 'metadataPaths', 'branch', 'previousHead', 'candidateCommit', 'mergedAt'].includes(key)) &&
    ['mergeCommit', 'tree', 'previousHead', 'candidateCommit'].every(commit) &&
    typeof merge.branch === 'string' && /^[^\\\s\x00-\x1f]{1,200}$/.test(merge.branch) &&
    typeof merge.mergedAt === 'string' && merge.mergedAt.length <= 40 && Number.isFinite(Date.parse(merge.mergedAt)) &&
    (merge.metadataPaths === undefined || Array.isArray(merge.metadataPaths) && merge.metadataPaths.length <= 512 && merge.metadataPaths.every(path => typeof path === 'string' && path.length <= 500 && !/[\\\r\n\x00-\x1f]/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..')));
}
