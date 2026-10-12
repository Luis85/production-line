import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { immutableGitEnvironment } from '../../../src/orchestrator/dist/orchestrator/infrastructure/git-environment.js';
import { gitContextSource } from '../../../src/orchestrator/dist/orchestrator/context/git-source.js';
import { importIteration } from '../../../src/orchestrator/dist/orchestrator/intake/importer.js';
const exec = promisify(execFile);

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'werk-git-environment-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repo = join(root, 'repo'); await mkdir(join(repo, 'docs', 'features'), { recursive: true });
    const env = immutableGitEnvironment();
    const git = (...args) => exec('git', ['-C', repo, '-c', 'core.autocrlf=false', ...args], { env });
    await git('init', '-q');
    const content = '---\nfactory_id: feature-1\nfactory_iteration: week-1\ntitle: Portable Git\nfactory_status: ready_for_implementation\nfactory_acceptance: [Read committed data]\n---\nPinned content.\n';
    await writeFile(join(repo, 'docs', 'features', 'Feature.md'), content);
    await git('add', '.');
    await git('-c', 'user.name=Werk Test', '-c', 'user.email=werk@example.invalid', 'commit', '-qm', 'Fixture');
    await git('branch', 'iteration/week-1');
    const commit = (await git('rev-parse', 'HEAD')).stdout.trim();
    return { root, repo, git, env, commit, content };
}

test('real Git accepts the portable null configuration path and ignores inherited global/system overrides', async t => {
    const f = await fixture(t), malicious = join(f.root, 'malformed.gitconfig');
    await writeFile(malicious, '[invalid configuration without closing bracket\n');
    const env = immutableGitEnvironment({ ...process.env, GIT_CONFIG_GLOBAL: malicious, GIT_CONFIG_SYSTEM: malicious,
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'werk.injected', GIT_CONFIG_VALUE_0: 'untrusted',
        gIt_DiR: join(f.root, 'missing-repository'), GIT_ALLOW_PROTOCOL: 'https:file', GIT_NO_REPLACE_OBJECTS: '0' });
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(env.GIT_NO_LAZY_FETCH, '1');
    assert.equal(env.GIT_ALLOW_PROTOCOL, ''); assert.equal(env.GIT_NO_REPLACE_OBJECTS, '1');
    assert.equal(env.GIT_CONFIG_COUNT, undefined); assert.equal(env.GIT_CONFIG_SYSTEM, undefined); assert.equal(env.gIt_DiR, undefined);
    await exec('git', ['-C', f.repo, 'check-ref-format', 'refs/heads/iteration/week-1'], { env });
    const result = await exec('git', ['-C', f.repo, 'cat-file', '-t', f.commit], { env });
    assert.equal(result.stdout.trim(), 'commit');
    await assert.rejects(exec('git', ['-C', f.repo, 'config', '--get', 'werk.injected'], { env }), error => error.code === 1);
});

test('pinned object reads and iteration previews use isolated Git configuration on every platform', async t => {
    const f = await fixture(t), malicious = join(f.root, 'malformed.gitconfig');
    await writeFile(malicious, '[invalid configuration without closing bracket\n');
    const overrides = { GIT_CONFIG_GLOBAL: malicious, GIT_CONFIG_SYSTEM: malicious, GIT_DIR: join(f.root, 'missing'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'werk.injected', GIT_CONFIG_VALUE_0: 'untrusted' };
    const old = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
    try {
        Object.assign(process.env, overrides);
        const source = await gitContextSource(f.repo, f.commit);
        const file = source.files.find(file => file.path === 'docs/features/Feature.md');
        assert.ok(file); assert.equal((await source.read(file)).toString('utf8'), f.content);
        const preview = await importIteration({ repo: f.repo, branch: 'iteration/week-1', project: 'demo', iteration: 'week-1', 'iteration-pr': 'https://example.invalid/pull/1', 'dry-run': 'true' }, '');
        assert.equal(preview.mode, 'preview'); assert.equal(preview.ready.length, 1); assert.equal(preview.ready[0].source.commit, f.commit);
    } finally {
        for (const [key, value] of old) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
});
