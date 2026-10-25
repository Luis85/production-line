import { managedProjectSetupStorage } from '../infrastructure/managed-project-setup-storage.js';
import { managedSetupCommand } from './workspace-managed-setup.js';
import type { ManagedSetupPlan, ManagedSetupResult, ManagedSetupPlanCommand, ManagedSetupApplyCommand, ManagedSetupReconcileCommand } from '../application/managed-project-setup.js';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, resolve } from 'node:path';
import { DomainError } from '../../shared/errors.js';
import { ManagedProjects, type ManagedProject, type ManagedProjectsView } from '../application/managed-projects.js';
import { featureWorkflowConfigPath, validateFeatureWorkflow } from '../application/feature-workflow.js';
import { deliveryPolicyPath } from '../application/delivery-policy.js';
import { managedProjectStorage } from '../infrastructure/managed-project-storage.js';
import { managedProjectGit } from '../infrastructure/managed-project-git.js';
import { parseFeature } from '../infrastructure/features/document.js';
import { findExecutable } from '../infrastructure/providers.js';
import { repositoryGit } from '../infrastructure/repositories-git.js';
import { readDeliveryPolicy } from '../infrastructure/delivery-policy.js';
import { projectFeatureTemplate } from './workspace-feature-templates.js';
import { assertRepositoryChangeAllowed } from './workspace-repositories.js';
import type { WorkspaceContext } from './workspace-context.js';

const signalFor = (workspace: WorkspaceContext) => AbortSignal.any([workspace.repositoryStop.signal, AbortSignal.timeout(150000)]);
async function executable(path: string) {
  if (!path || process.platform === 'win32' && extname(path).toLowerCase() !== '.exe') return false;
  try { if (!(await stat(path)).isFile()) return false; await access(path, constants.X_OK); return true; } catch { return false; }
}
async function diagnostics(workspace: WorkspaceContext, githubRequired: boolean): Promise<ManagedProjectsView['diagnostics']> {
  const claude = workspace.settings.value.providers.find(item => item.id === 'claude-cli')?.executable;
  return Promise.all(([
    { id: 'git', name: 'git', configured: undefined, required: true, applicable: true, detail: 'Git is required for managed clones. Transport authentication uses the worker host account.' },
    { id: 'claude', name: 'claude', configured: claude, required: workspace.settings.value.defaultProvider === 'claude-cli', applicable: true, detail: 'Claude Code uses the configured executable. Check its account in Settings → Providers; executable availability does not establish authentication.' },
    { id: 'github', name: 'gh', configured: undefined, required: githubRequired, applicable: githubRequired, detail: githubRequired
      ? 'An approved project policy enables GitHub pull requests or releases. GitHub CLI must be available and authenticated in the worker host account for those actions.'
      : 'GitHub CLI is optional. Plain Git publishes a feature branch and a PullRequest Markdown note; GitHub actions require an explicit approved project policy.' },
  ] as const).map(async item => {
    const path = item.configured || await findExecutable(item.name);
    return { id: item.id, available: await executable(path), detail: item.detail, required: item.required, applicable: item.applicable };
  }));
}
async function workflow(project: ManagedProject, signal: AbortSignal): Promise<ManagedProjectsView['projects'][number]['workflow']> {
  if (project.status !== 'ready' || !project.head) return { configured: false, templates: [] };
  try {
    const config = validateFeatureWorkflow(JSON.parse(await repositoryGit(project.path, ['show', `${project.head}:${featureWorkflowConfigPath}`], signal, 30000, 65536)));
    const listing = await repositoryGit(project.path, ['ls-tree', '-z', project.head, '--', config.template], signal, 30000, 65536);
    if (!/^100(?:644|755) blob /.test(listing)) return { configured: false, templates: [] };
    const template = parseFeature(await repositoryGit(project.path, ['show', `${project.head}:${config.template}`], signal, 30000, 65536));
    if (typeof template.data.templateId !== 'string') return { configured: false, templates: [] };
    return { configured: true, templates: [{ id: template.data.templateId, path: config.template, label: 'Project Feature Request' }, ...(config.templates ?? [])] };
  } catch { signal.throwIfAborted(); return { configured: false, templates: [] }; }
}
export async function managedProjectsView(workspace: WorkspaceContext): Promise<ManagedProjectsView> {
  const state = await managedProjectStorage(workspace.config.stateDir).load(), git = managedProjectGit(workspace.config.stateDir);
  const signal = signalFor(workspace);
  let githubRequired = false;
  const projects = await Promise.all(state.projects.map(async project => {
    const { operations: _operations, ...item } = project;
    const assignment = workspace.settings.value.repositories.items.find(value => value.id === project.id && resolve(value.path) === resolve(project.path));
    const binding = assignment ? workspace.featureProjects.resolve(project.id).sharedRuntime.intake.binding : undefined;
    const intakeEnabled = project.intake === 'shared' ? !!binding?.enabled && binding.repositoryId === project.id : assignment?.features?.directory === project.featuresDirectory;
    let policyApproved = false, policyPresent = false, baseline = project.head, intakeBlockedReason: string | null = null;
    try { const observation = await intakePolicy(workspace, project, signal); policyApproved = observation.approved; policyPresent = observation.present; baseline = observation.baseline; githubRequired ||= observation.approved && observation.githubEnabled; }
    catch { signal.throwIfAborted(); intakeBlockedReason = 'The committed delivery policy could not be checked. Restore repository access, then recheck project setup.'; }
    const configuredWorkflow = await workflow({ ...project, head: baseline }, signal);
    intakeBlockedReason = project.status !== 'ready' ? project.detail : intakeBlockedReason ?? (
      !assignment ? 'Restore this project repository assignment, then recheck setup.'
      : !policyPresent ? 'Commit .werk/delivery-policy.json, then approve its exact configuration in Project delivery.'
      : !policyApproved ? 'The current committed delivery policy is not approved. Review its exact configuration in Project delivery.'
      : project.intake === 'shared' && !configuredWorkflow.configured ? 'Commit the project Feature Request workflow and templates, then recheck setup.'
      : !intakeEnabled ? 'The delivery policy is approved. Recheck project setup to enable intake.' : null);
    const setupState = project.mode === 'clone' ? await managedProjectSetupStorage(workspace.config.stateDir, project.id).load() : undefined;
    const pending = setupState?.operations.findLast(operation => operation.status === 'prepared' || operation.status === 'unknown');
    const setup: ManagedSetupResult | undefined = pending ? { schemaVersion: 1, projectId: project.id, operationId: pending.operationId, branch: pending.plan.branch,
      ...(pending.commit ? { commit: pending.commit } : {}), ...(pending.status === 'prepared' ? { resumePlan: pending.plan } : {}), status: 'unknown', requiresPolicyApproval: true,
      detail: pending.status === 'prepared' ? 'Setup was interrupted before its first push. Inspect the retained preview and explicitly resume the same operation.'
        : 'The saved workflow publication needs reconciliation. Its push will not be repeated.' } : undefined;
    return { ...item, ...(setup ? { setup } : {}), intakeEnabled, policyApproved, intakeBlockedReason, workflow: configuredWorkflow };
  }));
  return { schemaVersion: 1, home: git.home, projects, diagnostics: await diagnostics(workspace, githubRequired) };
}
async function intakePolicy(workspace: WorkspaceContext, project: ManagedProject, signal: AbortSignal) {
  const assignment = workspace.settings.value.repositories.items.find(item => item.id === project.id && resolve(item.path) === resolve(project.path));
  const runtime = assignment ? workspace.featureProjects.resolve(project.id).sharedRuntime : undefined;
  const binding = runtime?.intake.binding;
  const baseline = binding?.enabled && binding.repositoryId === project.id ? await runtime!.selectedBaseline(signal)
    : (await repositoryGit(project.path, ['rev-parse', '--verify', 'HEAD^{commit}'], signal, 30000, 65536)).trim();
  const listing = await repositoryGit(project.path, ['ls-tree', '-z', baseline, '--', deliveryPolicyPath], signal, 30000, 65536);
  if (!/^100(?:644|755) blob /.test(listing)) return { approved: false, present: false, baseline, githubEnabled: false };
  const policy = await readDeliveryPolicy(project.path, signal, undefined, baseline);
  return { approved: workspace.deliveryApprovals.view().approvals.some(item => item.repositoryId === project.id && item.configurationDigest === policy.configurationDigest), present: true, baseline, githubEnabled: !!policy.configuration.remoteDelivery?.pullRequest || !!policy.configuration.release };
}
async function attach(workspace: WorkspaceContext, project: ManagedProject, signal: AbortSignal) {
  const current = workspace.settings.value.repositories;
  const existing = current.items.find(item => item.id === project.id);
  if (existing && (resolve(existing.path) !== resolve(project.path) || existing.branch && existing.branch !== project.branch || existing.features && existing.features.directory !== project.featuresDirectory))
    throw new DomainError('conflict', 'This project ID already belongs to another checkout or intake. Existing requests retain their assignment.');
  if (current.items.some(item => item.id !== project.id && resolve(item.path) === resolve(project.path)))
    throw new DomainError('conflict', 'The selected checkout already has another repository identity. Keep that assignment instead of importing its requests twice.');
  if (existing?.features && project.intake === 'shared') throw new DomainError('conflict', 'This repository already has local intake. Preserve its requests by adopting it with intake: local.');
  const { approved } = await intakePolicy(workspace, project, signal);
  const enableIntake = project.intake === 'local' && (!!existing?.features || approved);
  const assignment = { id: project.id, path: project.path, remote: 'origin', branch: project.branch, watch: existing?.watch ?? false,
    ...(enableIntake ? { features: { directory: project.featuresDirectory, pollMs: existing?.features?.pollMs ?? 1000 } } : {}) };
  const items = existing ? current.items.map(item => item.id === project.id ? assignment : item) : [...current.items, assignment];
  workspace.featureProjects.assertAssignments(items);
  if (JSON.stringify(items) !== JSON.stringify(current.items)) await workspace.settings.update({ repositories: { ...current, items } });
  await workspace.repositoryDiscovery.assignmentsChanged(workspace.settings.value.repositories.items);
  await workspace.repositories.configure(workspace.settings.value.repositories);
  await workspace.featureProjects.configure();
  if (project.intake === 'shared' && approved) {
    const selected = await projectFeatureTemplate(workspace, project.id);
    if (selected.snapshot.configuration.requestsDirectory !== project.featuresDirectory) throw new DomainError('conflict', 'The committed request directory differs from project registration. Use its configured featuresDirectory when registering the project.');
    const intake = workspace.featureProjects.resolve(project.id).sharedRuntime.intake, current = intake.view();
    const config = { enabled: true, repositoryId: project.id, remote: 'origin', branch: project.branch, workflowPath: featureWorkflowConfigPath, pollMs: current.config.pollMs };
    if (JSON.stringify(current.config) !== JSON.stringify(config)) await intake.configure(config, current.revision);
    await workspace.featureProjects.configure();
  }
}
/** The same admission gate protects CLI and HTTP setup; state stays private and no policy is approved here. */
export function managedProjectCommand(workspace: WorkspaceContext, input: ManagedSetupPlanCommand): Promise<ManagedSetupPlan>;
export function managedProjectCommand(workspace: WorkspaceContext, input: ManagedSetupApplyCommand | ManagedSetupReconcileCommand): Promise<ManagedSetupResult>;
export function managedProjectCommand(workspace: WorkspaceContext, input: unknown): Promise<ManagedProjectsView>;
export async function managedProjectCommand(workspace: WorkspaceContext, input: unknown): Promise<ManagedProjectsView | ManagedSetupPlan | ManagedSetupResult> {
  assertRepositoryChangeAllowed(workspace);
  if (workspace.featureProjects.busy) throw new DomainError('conflict', 'Wait for shared intake synchronization before changing project registration.');
  workspace.repositoriesUpdating = true;
  const signal = signalFor(workspace), git = managedProjectGit(workspace.config.stateDir);
  try {
    const action = (input as { action?: unknown } | null)?.action;
    if (action === 'setup_plan' || action === 'setup_apply' || action === 'setup_reconcile') return await managedSetupCommand(workspace, input, signal);
    const manager = new ManagedProjects({ ...managedProjectStorage(workspace.config.stateDir), ...git, attach: project => attach(workspace, project, signal) });
    await manager.command(input, signal);
    return await managedProjectsView(workspace);
  } finally { workspace.repositoriesUpdating = false; }
}
