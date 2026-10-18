import { sharedFeatureRequestReference } from './feature-request-reference.js';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { stringify } from 'yaml';
import { bindingKey,                                                } from './shared-feature-state.js';
                                                         
import { projectDevelopmentEvidence, renderDevelopmentEvidence } from './development-notes.js';

export const sharedHash = (text        ) => createHash('sha256').update(text).digest('hex');
export const sharedFeaturePublicationDigest = (record                                                              , outputDigest        ) => sharedHash(JSON.stringify([bindingKey(record.binding), record.id, record.sourceCommit, outputDigest]));
export function doneEvidence(record                     , execution                 )                             {
  const request = execution.request, result = request?.execution;
  if (!request || request.phase !== 'done' || request.policyDigest !== record.workflow.policyDigest || !result || result.status !== 'completed' || result.result?.type !== 'completed' || result.inputRevision !== request.inputRevision || !result.outputDigest || execution.currentTurnId !== result.turnId || execution.runId !== result.runId || !execution.patch) return;
  if (execution.implementation) {
    const evidence = projectDevelopmentEvidence(execution.implementation, execution.developmentEvidence);
    if (execution.developmentVerified !== true || !evidence.verified || evidence.baseCommit !== record.sourceCommit || result.facts['output.verificationPassed'] !== true || result.facts['output.candidateDigest'] !== evidence.candidateDigest) return;
  }
  const evaluation = request.evaluations.filter(e => e.stage === 'done' && e.inputRevision === request.inputRevision).at(-1);
  return evaluation?.passed && evaluation.inputHash === request.inputHash && evaluation.policyDigest === request.policyDigest && evaluation.outputDigest === result.outputDigest ? evaluation : undefined;
}
const cell = (value         ) => String(value ?? 'Unknown').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
export function renderSharedReview(record                     , execution                 , evaluation                )         {
  const config = record.workflow.configuration;
  const relative = posix.relative(config.reviewDirectory, record.sourcePath).replace(/\.md$/, '');
  const metadata = { schemaVersion: 1, type: 'PullRequest', featureId: record.id, featureRequestKey: sharedFeatureRequestReference(record).key, title: record.title, status: 'ready_for_review', owner: record.owner, feature: `[[${relative}]]`, featureBranch: record.featureBranch, featureCommit: record.featureCommit, sourceCommit: record.sourceCommit, policyDigest: record.workflow.policyDigest, outputDigest: record.outputDigest, createdAt: record.updatedAt };
  const development = execution.implementation ? renderDevelopmentEvidence(projectDevelopmentEvidence(execution.implementation, execution.developmentEvidence)) + '\n' : '';
  const rules = evaluation.rules.map(rule => `| ${cell(rule.ruleId)} | ${cell(rule.fact)} | ${cell(rule.expected)} | ${cell(rule.observed)} | ${rule.result} |`).join('\n');
  return '---\n' + stringify(metadata) + '---\n# ' + record.title.replace(/[\r\n]+/g, ' ') + '\n\nReady for human review. The worker has published the feature branch and passed the configured completion checks. This does not merge or approve the change.\n\n## Feature request\n\n[[' + relative + ']]\n\n## Review the implementation\n\n- Branch: `' + record.featureBranch + '`\n- Feature commit: `' + record.featureCommit + '`\n- Original source commit: `' + record.sourceCommit + '`\n- Ready check SHA-256: `' + record.workflow.files.readyCheck.sha256 + '`\n- Done check SHA-256: `' + record.workflow.files.doneCheck.sha256 + '`\n\n## Acceptance criteria\n\n' + record.accepted.criteria.map(item => '- ' + item.replace(/[\r\n]+/g, ' ')).join('\n') + '\n\n## Completion checks\n\n| Rule | Evidence | Expected | Observed | Result |\n| --- | --- | --- | --- | --- |\n' + rules + '\n\nTests or builds are verified only when explicitly shown as passing evidence in this note.\n\n## Worker summary\n\n' + (execution.summary ?? 'No summary was returned.') + '\n\n' + development + '## Human review\n\n- [ ] Inspect the feature branch and changes.\n- [ ] Check acceptance criteria and verification evidence.\n- [ ] Approve or request changes through the team’s normal review process.\n';
}

/** A configuration or gate blocker is informative only; it never fabricates an executable interaction. */
export function renderSharedBlocker(record                     , reason        )         {
  const metadata = { schemaVersion: 1, type: 'Task', status: !record.submitted && record.status === 'queued' ? 'waiting' : 'blocked', featureId: record.id, featureRequestKey: sharedFeatureRequestReference(record).key, owner: record.owner, title: record.title, sourceCommit: record.sourceCommit, inputHash: record.inputHash };
  const next = !record.submitted
    ? 'The worker has claimed this feature request but has not started an execution. Resolve the reported worker configuration or access issue, or wait for the stated hold to clear. The worker checks again automatically and retries admission using this same request identity. No answer or status change in this Task is needed.'
    : record.status === 'needs_rework'
    ? 'Create a corrected successor feature request from the project template, complete the readiness requirements, then commit and push it. The accepted request and its approved scope remain frozen.'
    : record.status === 'blocked'
      ? 'Restore the worker state or resolve its configuration and access issue. The worker will retry publication and inspect existing execution; it will not silently repeat a missing attempt.'
      : 'Inspect the reported checks or worker configuration. Resume only through a current actionable Task note when one is available, or create a corrected successor feature request and commit and push it.';
  return '---\n' + stringify(metadata) + '---\n# ' + record.title.replace(/[\r\n]+/g, ' ') + '\n\n## What needs attention\n\n' + reason.replace(/\r\n?/g, '\n').split('\n').map(line => '> ' + line).join('\n') + '\n\n## Next step\n\n' + next + '\n\nThis diagnostic does not accept answers or grant permissions. It describes the frozen request at source commit `' + record.sourceCommit + '`. Follow the current feature request for subsequent progress.\n';
}
