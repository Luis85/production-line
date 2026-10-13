import { join } from 'node:path';

/** Render an already validated, secret-free plan. Never create files or probe services. */
export function formatPlan(plan, { stateDir, file = 'system.yaml' } = {}) {
  const clean = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  const lines = [
    `Werk system: ${clean(plan.id)} · ${plan.environment}`,
    `Validated configuration: ${plan.totals.factories} factories, ${plan.totals.productionLines} production lines, ${plan.totals.workers} workers.`,
    'Preview only: no state, credentials or services created. Availability has not been checked.',
    '',
    `Factory ${clean(plan.factory.name)} (${plan.factory.id}): ${plan.factory.url}`,
  ];
  for (const child of plan.factory.subFactories) lines.push(`  Subfactory ${clean(child.name)} (${child.id}) → ${child.parentId}`);
  for (const line of plan.productionLines) {
    lines.push(`  Line ${clean(line.name)} (${line.id}) → ${line.factoryId}`, `    Project: ${line.project} · orchestrator: ${line.orchestrator.url}`, `    Workers: ${line.workers.count} · status ports: ${line.workers.statusPorts.join(', ')} · execution: ${line.workers.execution?.mode ?? 'mock'}`);
    if (line.orchestrator.webviewUrl) lines.push(`    Public webview: ${line.orchestrator.webviewUrl}`);
    if (line.workers.chat) lines.push(`    Chat: Codex CLI at ${clean(line.workers.chat.codexExecutable)} · operator login · conversation only`);
    if (line.workers.execution) lines.push(`    Live Codex: ${clean(line.workers.execution.codex.repository)} · allowed files: ${line.workers.execution.codex.allowedPaths.map(clean).join(', ')}`, '    Trusted tasks only; local patches require human review. Host file reads are not isolated.');
  }
  lines.push('', 'Execution defaults to simulation. A running worker with a matching profile is required to execute a task.');
  if (stateDir) lines.push(`State directory: ${clean(stateDir)}`, `Factory sign-in: WERK_FACTORY_ADMIN_TOKEN in ${clean(join(stateDir, 'factory/credentials.json'))}`, `Line sign-in: WERK_ADMIN_TOKEN in ${clean(join(stateDir, 'lines/<line-id>/credentials.json'))}`, 'Credentials are separate; enrollment tokens are for workers. Token values are never included in this preview.');
  lines.push('', 'Next: review ports and ownership, then run system up with the same --file and --state-dir options.', plan.environment === 'docker' ? 'Launcher: bash werk-docker.sh (Windows: ./werk-docker.ps1).' : 'Launcher: node werk.mjs. Keep its terminal open; Ctrl+C drains the system.');
  return lines.join('\n');
}
