import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { stringify } from 'yaml';
import { bindingKey, type SharedFeatureRecord, type SharedExecution } from './shared-feature-state.js';
import type { GateEvaluation } from './request-gates.js';

export const sharedHash = (text: string) => createHash('sha256').update(text).digest('hex');
export const sharedFeaturePublicationDigest = (record: Pick<SharedFeatureRecord, 'binding' | 'id' | 'sourceCommit'>, outputDigest: string) => sharedHash(JSON.stringify([bindingKey(record.binding), record.id, record.sourceCommit, outputDigest]));
export function doneEvidence(record: SharedFeatureRecord, execution: SharedExecution): GateEvaluation | undefined {
  const request = execution.request, result = request?.execution;
  if (!request || request.phase !== 'done' || request.policyDigest !== record.workflow.policyDigest || !result || result.status !== 'completed' || result.result?.type !== 'completed' || result.inputRevision !== request.inputRevision || !result.outputDigest || execution.currentTurnId !== result.turnId || execution.runId !== result.runId || !execution.patch) return;
  const evaluation = request.evaluations.filter(e => e.stage === 'done' && e.inputRevision === request.inputRevision).at(-1);
  return evaluation?.passed && evaluation.inputHash === request.inputHash && evaluation.policyDigest === request.policyDigest && evaluation.outputDigest === result.outputDigest ? evaluation : undefined;
}
const cell = (value: unknown) => String(value ?? 'Unknown').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
export function renderSharedReview(record: SharedFeatureRecord, execution: SharedExecution, evaluation: GateEvaluation): string {
  const config = record.workflow.configuration;
  const relative = posix.relative(config.reviewDirectory, record.sourcePath).replace(/\.md$/, '');
  const metadata = { schemaVersion: 1, type: 'feature-review', featureId: record.id, title: record.title, status: 'ready_for_review', owner: record.owner, feature: `[[${relative}]]`, featureBranch: record.featureBranch, featureCommit: record.featureCommit, sourceCommit: record.sourceCommit, policyDigest: record.workflow.policyDigest, outputDigest: record.outputDigest, createdAt: record.updatedAt };
  const rules = evaluation.rules.map(rule => `| ${cell(rule.ruleId)} | ${cell(rule.fact)} | ${cell(rule.expected)} | ${cell(rule.observed)} | ${rule.result} |`).join('\n');
  return '---\n' + stringify(metadata) + '---\n# ' + record.title.replace(/[\r\n]+/g, ' ') + '\n\nReady for human review. The worker has published the feature branch and passed the configured completion checks. This does not merge or approve the change.\n\n## Feature request\n\n[[' + relative + ']]\n\n## Review the implementation\n\n- Branch: `' + record.featureBranch + '`\n- Feature commit: `' + record.featureCommit + '`\n- Original source commit: `' + record.sourceCommit + '`\n- Ready check SHA-256: `' + record.workflow.files.readyCheck.sha256 + '`\n- Done check SHA-256: `' + record.workflow.files.doneCheck.sha256 + '`\n\n## Acceptance criteria\n\n' + record.accepted.criteria.map(item => '- ' + item.replace(/[\r\n]+/g, ' ')).join('\n') + '\n\n## Completion checks\n\n| Rule | Evidence | Expected | Observed | Result |\n| --- | --- | --- | --- | --- |\n' + rules + '\n\nTests or builds are verified only when explicitly shown as passing evidence above.\n\n## Worker summary\n\n' + (execution.summary ?? 'No summary was returned.') + '\n\n## Human review\n\n- [ ] Inspect the feature branch and changes.\n- [ ] Check acceptance criteria and verification evidence.\n- [ ] Approve or request changes through the team’s normal review process.\n';
}
