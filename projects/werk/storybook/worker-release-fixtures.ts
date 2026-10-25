import type { ReleaseOperation, ReleaseView } from '../src/worker/application/release-contracts';
import type { ManagedProjectsView } from '../src/worker/application/managed-projects';
import type { GateCommandFields } from '../src/worker/webview/request-gate-controller';
import { installExpandedDeliveryFixture } from './worker-expanded-delivery-fixtures';
import { fixtureTime } from './worker-fixtures';
import { state } from '../src/worker/webview/store';
export function installReleaseFixture(variant: 'merge' | 'build' | 'publish' | 'unknown' | 'published' = 'merge') {
  const base = installExpandedDeliveryFixture(), candidate = base.review.candidate, commands: GateCommandFields[] = [];
  const target = { repository: 'example/web', base: 'main', mergeMethod: 'squash' as const, tagPrefix: 'v', prerelease: true, build: { executable: 'node', args: ['scripts/build.mjs'], timeoutMs: 600000, artifacts: ['release/application.zip'] } };
  base.policy.configuration.release = target;
  base.request.attestation = { actor: 'operator', inputHash: base.request.inputHash, outputDigest: base.request.execution!.outputDigest!, note: 'Illustrative current-candidate acceptance.', at: fixtureTime };
  base.request.lifecycle = 'done'; base.request.phase = 'done';
  const release: ReleaseView = { configured: true, authorized: true, reason: null, target, candidate, state: { operations: [] }, canMerge: variant === 'merge', canBuild: variant === 'build', canPublish: variant === 'publish', canReconcile: variant === 'unknown', canConfirmStopped: variant === 'unknown' };
  if (variant !== 'merge') release.state.merge = { pullRequest: 42, headCommit: candidate.candidateCommit, mergeCommit: '9'.repeat(40), url: 'https://github.com/example/web/pull/42', mergedAt: fixtureTime };
  if (['publish', 'published'].includes(variant)) release.state.build = { operationId: 'example-build', commit: release.state.merge!.mergeCommit, artifacts: [{ name: 'application.zip', bytes: 42000, sha256: 'a'.repeat(64) }], manifestDigest: 'b'.repeat(64), builtAt: fixtureTime };
  if (variant === 'published') release.state.published = { tag: 'v1.0.0-example', url: 'https://github.com/example/web/releases/tag/v1.0.0-example', commit: release.state.build!.commit, assets: release.state.build!.artifacts, publishedAt: fixtureTime };
  if (variant === 'unknown') {
    const operation: ReleaseOperation = { operationId: 'example-build-unknown', action: 'build', status: 'unknown', candidate, target, repositoryId: 'web', configurationDigest: base.policy.configurationDigest, pullRequest: { number: 42, url: 'https://github.com/example/web/pull/42', branch: candidate.branch }, createdAt: fixtureTime, updatedAt: fixtureTime, detail: 'The worker restarted before this build’s outcome was confirmed.' };
    release.state.operations = [operation];
  }
  base.run.release = release.state;
  const original = (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__;
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href), body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    if (url.pathname === '/api/requests' && body.action === 'release') return Response.json(release);
    return original(input, init);
  };
  return { ...base, release, commands, command: (fields: GateCommandFields) => { commands.push(fields); } };
}
export function installManagedProjectsFixture() {
  const base = installExpandedDeliveryFixture(), commands: Record<string, unknown>[] = [];
  const projects: ManagedProjectsView = { schemaVersion: 1, home: 'C:\\Werk\\projects', projects: [{ id: 'web', name: 'Customer portal', mode: 'clone', intake: 'shared', repository: 'https://github.com/example/web.git', branch: 'main', featuresDirectory: 'features', path: 'C:\\Werk\\projects\\web\\checkout', operationId: 'example-registration', status: 'ready', attached: true, intakeEnabled: false, createdAt: fixtureTime, updatedAt: fixtureTime, detail: 'Repository cloned and registered. Approve its committed delivery policy to enable intake.', head: 'a'.repeat(40), workflow: { configured: true, templates: [{ id: 'default', path: 'features/_templates/feature-request.md', label: 'Project default' }] } }], diagnostics: [{ id: 'git', available: true, detail: 'Git executable found.' }, { id: 'claude', available: true, detail: 'Claude Code executable found; account access is checked separately.' }, { id: 'github', available: true, detail: 'GitHub CLI found; repository access is checked when used.' }] };
  const original = (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__;
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname === '/api/managed-projects') { if (init.method === 'POST') commands.push(JSON.parse(String(init.body))); return Response.json(projects); }
    return original(input, init);
  };
  state.draftEpoch++;
  return { ...base, projects, commands };
}
