import { join } from 'node:path';
import { DomainError } from '../../shared/errors.js';
import { deliveryPolicyPath, validateDeliveryProjectPolicy } from '../application/delivery-policy.js';
import { newDeliveryProjectPolicy } from '../application/delivery-policy-template.js';
import { defaultFeatureWorkflow, defaultFeatureCheck, featureContentHash, featureWorkflowConfigPath, validateFeatureWorkflow } from '../application/feature-workflow.js';
import { managedSetupDigest, type ManagedSetupPlan, type ManagedSetupOperation } from '../application/managed-project-setup.js';
import type { ManagedProject } from '../application/managed-projects.js';
import { authoringBase, authoringDefinitionPrompt, authoringReadyReviewPrompt, authoringTemplateFor } from './feature-authoring-assets.js';
import type { ProviderId } from '../application/provider-contract.js';
import { FeatureGitIo, gitPath, assertPublicationPath } from './features/git-io.js';
import { loadFeatureWorkflowSnapshot } from './features/workflow.js';
import { managedProjectLocations, type ManagedProjectLocationPort } from './managed-project-locations.js';
import { managedProjectGit } from './managed-project-git.js';
import type { RepositoryRoot } from './repositories-git.js';

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const conflict = (message: string): never => { throw new DomainError('conflict', message); };
function parsed(content: string, label: string): unknown {
  try { return JSON.parse(content); } catch { throw new DomainError('invalid_input', `The committed ${label} must contain valid JSON. Preserve it and correct its contents before setup.`); }
}
/** Git remains an edge adapter: this service only installs generated missing files in private publication worktrees. */
export function managedProjectSetupGit(stateDirectory: string, project: ManagedProject, signal: AbortSignal, locations: ManagedProjectLocationPort = managedProjectLocations(stateDirectory)) {
  const managed = managedProjectGit(stateDirectory, locations);
  const io = new FeatureGitIo({ repository: project.path, remote: 'origin', stateDirectory: join(project.mode === 'clone' ? locations.placement(project).privateDirectory : join(stateDirectory, 'blocked-external-setup'), 'setup') });
  async function checked() {
    if (project.mode !== 'clone') conflict('Workflow setup is available only for worker-owned managed clones. Preserve external checkout history and register a separate isolated remote clone.');
    if (!(await managed.inspect(project, signal)).ready) conflict('Restore the registered worker checkout before setting up its workflow.');
    return io.root(signal);
  }
  async function clean(root: string) {
    if ((await io.output(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal)).length) conflict('The worker-owned checkout has local changes. Preserve and resolve them before setting up the workflow.');
    return (await io.output(root, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim();
  }
  async function ancestor(root: string, before: string, after: string) {
    return (await io.git(root, ['merge-base', '--is-ancestor', before, after], signal, undefined, true)).exitCode === 0;
  }
  async function plan(provider: string): Promise<ManagedSetupPlan> {
    const root = await checked(); assertPublicationPath(io.options.stateDirectory, root.path);
    const checkoutCommit = await clean(root.path), baseCommit = (await io.fetch(root, project.branch, signal))!;
    if (!await ancestor(root.path, checkoutCommit, baseCommit)) conflict('The worker checkout diverged from its shared branch. Restore its registered baseline before setup.');
    const saved = await io.blob(root, baseCommit, featureWorkflowConfigPath, signal);
    const configuration = saved ? validateFeatureWorkflow(parsed(saved.content, 'workflow configuration')) : validateFeatureWorkflow({ ...defaultFeatureWorkflow(), requestsDirectory: project.featuresDirectory, template: project.featuresDirectory + '/_templates/feature-request.md' });
    if (configuration.requestsDirectory !== project.featuresDirectory) conflict('The committed workflow request directory differs from project registration. Preserve that workflow and correct registration before setup.');
    const files: Record<string, string> = {
      [featureWorkflowConfigPath]: json(configuration), [deliveryPolicyPath]: json({ ...newDeliveryProjectPolicy(), localMerge: true }),
      [configuration.template]: authoringTemplateFor(provider as ProviderId), [configuration.base]: authoringBase(configuration),
      [configuration.readyCheck]: json(defaultFeatureCheck('ready')), [configuration.doneCheck]: json(defaultFeatureCheck('done')),
    };
    for (const [path, content] of [[configuration.readyPrompt, authoringDefinitionPrompt('ready')], [configuration.donePrompt, authoringDefinitionPrompt('done')], [configuration.readyReviewPrompt, authoringReadyReviewPrompt()]] as const) if (path) files[path] = content;
    for (const item of configuration.templates ?? []) {
      const blob = await io.blob(root, baseCommit, item.path, signal);
      if (!blob) return conflict('An additional registered request template is missing. Restore the team-authored template before setup.');
      files[item.path] = blob.content;
    }
    const planned: ManagedSetupPlan['files'] = [];
    for (const [path, content] of Object.entries(files)) {
      gitPath(path);
      const parts = path.split('/');
      for (let index = 0; index < parts.length; index++) {
        const tree = index ? baseCommit + ':' + parts.slice(0, index).join('/') : baseCommit;
        const entries = (await io.output(root.path, ['ls-tree', '-z', tree], signal)).split('\0').filter(Boolean);
        const part = parts[index]!;
        if (entries.some(entry => { const name = entry.slice(entry.indexOf('\t') + 1); return name !== part && name.normalize('NFC').toLowerCase() === part.normalize('NFC').toLowerCase(); })) conflict('A setup path collides with an existing filename on case-insensitive filesystems. Preserve it and correct the workflow paths.');
        const exact = entries.find(entry => entry.slice(entry.indexOf('\t') + 1) === part);
        if (!exact) break;
        if (index < parts.length - 1 && !exact.startsWith('040000 tree ')) conflict('A setup path has a tracked non-directory or symbolic-link ancestor. Preserve it and correct the workflow paths.');
      }
      const existing = await io.blob(root, baseCommit, path, signal);
      const selected = existing?.content ?? content;
      planned.push({ path, status: existing ? 'preserve' : 'create', content: selected, sha256: featureContentHash(selected) });
    }
    const policy = planned.find(file => file.path === deliveryPolicyPath)!;
    validateDeliveryProjectPolicy(parsed(policy.content, 'delivery policy'));
    await loadFeatureWorkflowSnapshot({ commit: baseCommit, readBlob: async (_commit, path) => planned.find(file => file.path === path)?.content ?? (await io.blob(root, baseCommit, path, signal))?.content ?? null });
    const subject = { schemaVersion: 1 as const, projectId: project.id, branch: project.branch, baseCommit, checkoutCommit, provider, files: planned, requiresPolicyApproval: true as const };
    return { ...subject, planDigest: managedSetupDigest(subject) };
  }
  async function verifyCommit(root: RepositoryRoot, operation: ManagedSetupOperation) {
    if (!operation.commit) return conflict('The setup operation has no retained commit identity.');
    const parents = (await io.output(root.path, ['rev-list', '--parents', '-n', '1', operation.commit], signal)).trim().split(' ');
    if (parents.length !== 2 || parents[1] !== operation.plan.baseCommit) conflict('The retained setup commit parent changed. Inspect its immutable publication identity.');
    const message = await io.output(root.path, ['log', '-1', '--format=%B', operation.commit], signal);
    if (!message.includes(`Werk-Operation: ${operation.operationId}\n`) || !message.includes(`Werk-Payload: ${operation.plan.planDigest}\n`)) conflict('The retained setup commit no longer matches its reviewed plan.');
    const changed = (await io.output(root.path, ['diff', '--name-only', '-z', operation.plan.baseCommit, operation.commit, '--'], signal)).split('\0').filter(Boolean).sort();
    const expected = operation.plan.files.filter(file => file.status === 'create').map(file => file.path).sort();
    if (JSON.stringify(changed) !== JSON.stringify(expected)) conflict('The retained setup commit changed files outside its reviewed missing-file set.');
    for (const file of operation.plan.files) {
      const blob = await io.blob(root, operation.commit, file.path, signal);
      if (blob?.revision !== file.sha256 || file.status === 'create' && blob.mode !== '100644') conflict('The retained setup commit does not contain its exact reviewed files.');
    }
  }
  async function observe(operation: ManagedSetupOperation) {
    if (!operation.commit) return false;
    const root = await checked(), head = await io.fetch(root, project.branch, signal);
    if (!head || !await ancestor(root.path, operation.commit, head)) return false;
    await verifyCommit(root, operation); return true;
  }
  return {
    plan,
    async commit(preview: ManagedSetupPlan, operationId: string) {
      if ((await plan(preview.provider)).planDigest !== preview.planDigest) conflict('The repository changed after the setup preview. Refresh it before applying.');
      const root = await checked();
      return io.worktree(root, preview.baseCommit, signal, async worktree => {
        for (const file of preview.files.filter(file => file.status === 'create')) await io.write(worktree, file.path, file.content, '100644', signal);
        return io.commit(worktree, preview.baseCommit, operationId, preview.planDigest, signal);
      });
    },
    async publish(operation: ManagedSetupOperation): Promise<'confirmed' | 'rejected' | 'unknown'> {
      const root = await checked(); await verifyCommit(root, operation);
      if (await clean(root.path) !== operation.plan.checkoutCommit) conflict('The worker checkout changed before setup publication. Preserve it and reconcile the saved operation.');
      // The prepared commit is a child of exactly baseCommit; the lease prohibits replacing any intervening teammate commit.
      const result = await io.git(root.path, ['push', '--porcelain', '--no-verify', '--no-follow-tags', `--force-with-lease=refs/heads/${project.branch}:${operation.plan.baseCommit}`, '--', 'origin', `${operation.commit}:refs/heads/${project.branch}`], signal, undefined, true);
      // Only Git's explicit per-ref rejection is definitive. Transport/process failures remain uncertain.
      const rejected = result.exitCode !== 0 && result.stdout.toString('utf8').split('\n').some(line => {
        const [status, ref, detail] = line.split('\t');
        return status === '!' && ref === `${operation.commit}:refs/heads/${project.branch}` && /^\[(?:rejected|remote rejected)\]/.test(detail ?? '');
      });
      if (rejected) return 'rejected';
      return await observe(operation) ? 'confirmed' : 'unknown';
    },
    observe,
    async advance(operation: ManagedSetupOperation) {
      const root = await checked(), head = await clean(root.path);
      if (head === operation.commit) return;
      if (head !== operation.plan.checkoutCommit || !await ancestor(root.path, head, operation.commit!)) conflict('The setup commit is published, but the worker checkout changed. Restore its clean preview baseline and reconcile.');
      await io.output(root.path, ['merge', '--ff-only', '--no-edit', operation.commit!], signal);
      if (await clean(root.path) !== operation.commit) conflict('The worker checkout did not confirm the setup commit. Inspect it before policy approval.');
    },
  };
}
