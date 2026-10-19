import { testErrorStatus } from '../helpers/process-errors.mjs';
import { testErrorMessage } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readFile, mkdir, stat, chmod, access, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseEnvironment, loadEnvironment, environmentDefaults, environmentExample, seedEnvironment } from '../../scripts/runtime/portable/environment.mjs';

const runFile = promisify(execFile), tokenA = 'a'.repeat(64), tokenB = 'b'.repeat(64), tokenC = 'c'.repeat(64);
const gitEnvironment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' });
const git = (directory, ...args) => runFile('git', ['-C', directory, ...args], { env: gitEnvironment(), windowsHide: true });
async function directory(t) { const path = await realpath(await mkdtemp(join(tmpdir(), 'werk-environment-'))); t.after(() => rm(path, { recursive: true, force: true })); return path; }
const privateText = (path, value) => writeFile(path, value, { mode: 0o600 });
const missing = async path => assert.rejects(access(path), { code: 'ENOENT' });
async function savedWorker(project, name, token = tokenA) { const path = join(project, name); await mkdir(path, { recursive: true, mode: 0o700 }); await privateText(join(path, 'webview-token'), token + '\n'); return path; }
async function savedComponent(project, kind, changes = {}) { const path = join(project, kind); await mkdir(path, { recursive: true, mode: 0o700 }); await privateText(join(path, 'component.json'), JSON.stringify({ schemaVersion: 1, kind, project: 'demo', adminToken: tokenA, enrollmentToken: tokenB, ...changes })); return path; }
function temporaryEnvironment(t, values) { const prior = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); for (const [key, value] of Object.entries(values)) process.env[key] = value; t.after(() => { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }); }

test('dotenv parsing interprets supported keys only, without expanding shell text', () => {
  const values = parseEnvironment('worker', [
    '\uFEFF# project configuration', 'PATH=first', 'PATH=second', 'BROKEN unrelated syntax',
    'MULTILINE="start', 'WERK_WORKER_PORT=9999', 'end"',
    'export WERK_WORKER_HOST="localhost # quoted" # comment',
    "WERK_WORKER_CONFIG='${HOME}/$(touch something)/worker.json'", 'WERK_WORKER_PORT=4109 # comment',
    'WERK_APP_TOKEN=never-load', 'NODE_OPTIONS=never-load', '',
  ].join('\r\n'));
  assert.deepEqual({ ...values }, { WERK_WORKER_HOST: 'localhost # quoted', WERK_WORKER_CONFIG: '${HOME}/$(touch something)/worker.json', WERK_WORKER_PORT: '4109' });
  assert.throws(() => parseEnvironment('worker', 'WERK_WORKER_PORT=4100\nWERK_WORKER_PORT=4200'), /Duplicate .env assignment for WERK_WORKER_PORT/);
  for (const source of ['WERK_WORKER_HOST no-assignment', 'WERK_WORKER_HOST="unterminated', 'WERK_WORKER_HOST="value" trailing', 'WERK_WORKER_HOST="two\nlines"']) assert.throws(() => parseEnvironment('worker', source), /Invalid .env value/);
  const sensitive = 'sensitive-value-do-not-echo';
  assert.throws(() => parseEnvironment('worker', 'WERK_WORKER_TOKEN="' + sensitive), error => !testErrorMessage(error).includes(sensitive) && testErrorStatus(error, 'exitCode') === 2);
});

test('loading is allowlisted and process values win, including disabled enrollment', async t => {
  const project = await directory(t), legacyEnrollment = 'legacy-enrollment-credential-24-plus';
  await privateText(join(project, '.env'), ['WERK_WORKER_TOKEN=' + tokenA, 'WERK_ENROLLMENT_TOKEN=' + legacyEnrollment, 'WERK_WORKER_PORT=4109', 'WERK_APP_TOKEN=never-load', 'NODE_OPTIONS=never-load', 'PATH=never-load'].join('\n'));
  const environment = { WERK_WORKER_TOKEN: tokenB, WERK_ENROLLMENT_TOKEN: '', WERK_WORKER_PORT: '4200' };
  const result = await loadEnvironment('worker', project, environment);
  assert.deepEqual(environment, { WERK_WORKER_TOKEN: tokenB, WERK_ENROLLMENT_TOKEN: '', WERK_WORKER_PORT: '4200' });
  assert.deepEqual(result.loaded, []);
  assert.equal(JSON.stringify(result).includes(tokenA), false);
  /** @type {Record<string, string | undefined>} */
  const inherited = {}; await loadEnvironment('worker', project, inherited);
  assert.equal(inherited.WERK_ENROLLMENT_TOKEN, legacyEnrollment);
  assert.equal(inherited.WERK_APP_TOKEN, undefined);
  assert.equal(inherited.PATH, undefined);
  await assert.rejects(loadEnvironment('worker', project, { WERK_WORKER_TOKEN: '' }), /64 lowercase hexadecimal/);
});

test('relative environment state and config paths use the explicit project directory', async t => {
  const project = await directory(t), absolute = join(project, 'absolute.json');
  assert.deepEqual(environmentDefaults('worker', { WERK_WORKER_STATE_DIR: 'state/custom', WERK_WORKER_CONFIG: 'config/worker.json', WERK_WORKER_PORT: '4111' }, project), { 'state-dir': resolve(project, 'state/custom'), config: resolve(project, 'config/worker.json'), port: '4111' });
  assert.equal(environmentDefaults('worker', { WERK_WORKER_CONFIG: absolute }, project).config, absolute);
  assert.throws(() => environmentDefaults('worker', { WERK_WORKER_HOST: '\nunsafe' }, project), /Invalid environment option/);
});

test('fresh initialization creates private local credentials and a shareable example', async t => {
  const project = await directory(t); await git(project, 'init', '-q');
  await writeFile(join(project, '.gitignore'), '.env.*\n');
  const result = await seedEnvironment('worker', project, { environment: {} });
  const text = await readFile(join(project, '.env'), 'utf8'), values = parseEnvironment('worker', text), example = await readFile(join(project, '.env.example'), 'utf8');
  assert.match(values.WERK_WORKER_TOKEN, /^[a-f0-9]{64}$/);
  assert.equal(values.WERK_ENROLLMENT_TOKEN, undefined);
  assert.equal(example.includes(values.WERK_WORKER_TOKEN), false);
  assert.equal(JSON.stringify(result).includes(values.WERK_WORKER_TOKEN), false);
  assert.equal(example, environmentExample('worker'));
  assert.equal(result.created, true);
  assert.match((await git(project, 'check-ignore', '.env')).stdout, /\.env/);
  await assert.rejects(git(project, 'check-ignore', '.env.example'), { code: 1 });
  if (process.platform !== 'win32') assert.equal((await stat(join(project, '.env'))).mode & 0o777, 0o600);
});

test('initialization preserves existing bytes and values, is idempotent and supports Windows quoted paths', async t => {
  const project = await directory(t), original = '# project values\r\nCUSTOM="unchanged"\r\nWERK_WORKER_TOKEN=' + tokenA + '\r\nWERK_WORKER_PORT=4555\r\n';
  await privateText(join(project, '.env'), original);
  const windowsPath = "C:\\new\\O'Connor\\worker.json";
  const options = { environment: { WERK_WORKER_TOKEN: tokenB, WERK_WORKER_PORT: '4666' }, defaults: { config: windowsPath } };
  await seedEnvironment('worker', project, options);
  const first = await readFile(join(project, '.env'), 'utf8'), values = parseEnvironment('worker', first);
  assert.equal(first.startsWith(original), true);
  assert.equal(values.WERK_WORKER_TOKEN === tokenA, true);
  assert.equal(values.WERK_WORKER_PORT, '4555');
  assert.equal(values.WERK_WORKER_CONFIG, windowsPath);
  assert.equal(first.replaceAll('\r\n', '').includes('\n'), false);
  const again = await seedEnvironment('worker', project, options);
  assert.deepEqual(again.added, []);
  assert.equal(await readFile(join(project, '.env'), 'utf8'), first);
});

test('initialization derives saved identity from dotenv state and honors explicit process token precedence', async t => {
  const project = await directory(t); await savedWorker(project, 'custom-state');
  await privateText(join(project, '.env'), 'WERK_WORKER_STATE_DIR=custom-state\n');
  await seedEnvironment('worker', project, { environment: {} });
  assert.equal(parseEnvironment('worker', await readFile(join(project, '.env'), 'utf8')).WERK_WORKER_TOKEN === tokenA, true);
  const second = await directory(t); await savedWorker(second, 'process-state');
  await seedEnvironment('worker', second, { environment: { WERK_WORKER_STATE_DIR: 'process-state', WERK_WORKER_TOKEN: tokenB } });
  const values = parseEnvironment('worker', await readFile(join(second, '.env'), 'utf8'));
  assert.equal(values.WERK_WORKER_TOKEN === tokenB, true);
  assert.equal(values.WERK_WORKER_STATE_DIR, 'process-state');
  const third = await directory(t); await savedWorker(third, 'process-state', tokenC);
  await seedEnvironment('worker', third, { environment: { WERK_WORKER_STATE_DIR: 'process-state' } });
  assert.equal(parseEnvironment('worker', await readFile(join(third, '.env'), 'utf8')).WERK_WORKER_TOKEN === tokenC, true);
});

test('application namespaces coexist and initialization reuses saved component identities', async t => {
  const project = await directory(t), factory = await savedComponent(project, 'factory'), orchestrator = await savedComponent(project, 'orchestrator');
  await seedEnvironment('worker', project, { environment: {} });
  await seedEnvironment('factory', project, { stateDirectory: factory, defaults: { 'state-dir': 'factory' }, environment: {} });
  await seedEnvironment('orchestrator', project, { stateDirectory: orchestrator, defaults: { 'state-dir': 'orchestrator' }, environment: {} });
  const text = await readFile(join(project, '.env'), 'utf8'), factoryValues = parseEnvironment('factory', text), orchestratorValues = parseEnvironment('orchestrator', text);
  assert.equal(factoryValues.WERK_FACTORY_ADMIN_TOKEN === tokenA, true);
  assert.equal(orchestratorValues.WERK_ADMIN_TOKEN === tokenA, true);
  assert.equal(orchestratorValues.WERK_ENROLLMENT_TOKEN === tokenB, true);
  const example = await readFile(join(project, '.env.example'), 'utf8');
  for (const kind of ['worker', 'factory', 'orchestrator']) assert.equal(example.includes(environmentExample(kind)), true);
  assert.equal(example.includes(tokenA) || example.includes(tokenB), false);
});

test('credential load never changes permissions and explicit initialization repairs an unchanged untracked file', { skip: process.platform === 'win32' }, async t => {
  const project = await directory(t); await seedEnvironment('worker', project, { environment: {} });
  const path = join(project, '.env'), original = await readFile(path, 'utf8'); await chmod(path, 0o644);
  await assert.rejects(loadEnvironment('worker', project, {}), /must be private/);
  assert.equal((await stat(path)).mode & 0o777, 0o644);
  const result = await seedEnvironment('worker', project, { environment: {} });
  assert.deepEqual(result.added, []);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await loadEnvironment('worker', project, {});
});

test('tracked dotenv refuses new credentials despite ambient Git repository and index overrides', async t => {
  const project = await directory(t), other = await directory(t); await git(project, 'init', '-q'); await git(other, 'init', '-q');
  await privateText(join(project, '.env'), '# existing tracked project settings\n'); await git(project, 'add', '.env');
  temporaryEnvironment(t, { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, '.git', 'index'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true' });
  await assert.rejects(seedEnvironment('worker', project, { environment: {} }), /tracked by Git/);
  assert.equal(await readFile(join(project, '.env'), 'utf8'), '# existing tracked project settings\n');
  await missing(join(project, '.env.example')); await missing(join(project, '.gitignore'));
});

test('mode-only repair refuses a tracked dotenv and leaves its permissions unchanged', { skip: process.platform === 'win32' }, async t => {
  const project = await directory(t); await git(project, 'init', '-q'); await seedEnvironment('worker', project, { environment: {} });
  await git(project, 'add', '-f', '.env'); await chmod(join(project, '.env'), 0o644);
  await assert.rejects(seedEnvironment('worker', project, { environment: {} }), /tracked by Git/);
  assert.equal((await stat(join(project, '.env'))).mode & 0o777, 0o644);
});

test('initializer preflights links, oversized files and invalid UTF-8 before writing credentials', async t => {
  for (const kind of ['hardlink', 'oversize', 'utf8']) {
    const project = await directory(t), destination = join(project, '.env.example');
    if (kind === 'hardlink') { await writeFile(join(project, 'original'), 'example'); await link(join(project, 'original'), destination); }
    if (kind === 'oversize') await writeFile(destination, 'x'.repeat(65537));
    if (kind === 'utf8') await writeFile(destination, Buffer.from([0xff]));
    await assert.rejects(seedEnvironment('worker', project, { environment: {} }), /hard links|64 KiB|UTF-8/);
    await missing(join(project, '.env')); await missing(join(project, '.gitignore'));
  }
});

test('dotenv symlinks cannot redirect read or initialization', { skip: process.platform === 'win32' }, async t => {
  const project = await directory(t); await privateText(join(project, 'target'), 'WERK_WORKER_TOKEN=' + tokenA + '\n'); await symlink(join(project, 'target'), join(project, '.env'));
  await assert.rejects(loadEnvironment('worker', project, {}), /regular files, not links/);
  await assert.rejects(seedEnvironment('worker', project, { environment: {} }), /regular files, not links/);
  await missing(join(project, '.env.example'));
});

test('Git absence is allowed outside checkouts and fails closed in a known checkout', async t => {
  const project = await directory(t), checkout = await directory(t); await mkdir(join(checkout, '.git'));
  temporaryEnvironment(t, { PATH: join(project, 'no-executables') });
  await seedEnvironment('worker', project, { environment: {} });
  await assert.rejects(seedEnvironment('worker', checkout, { environment: {} }), /Could not verify whether .env is tracked/);
  await missing(join(checkout, '.env')); await missing(join(checkout, '.env.example')); await missing(join(checkout, '.gitignore'));
});

test('invalid saved component identities and equal token combinations fail before any setup writes', async t => {
  for (const changes of [{ project: 'bad/project' }, { adminToken: tokenB }, { enrollmentToken: 'short' }, { kind: 'worker' }]) {
    const project = await directory(t), stateDirectory = await savedComponent(project, 'orchestrator', changes);
    await assert.rejects(seedEnvironment('orchestrator', project, { stateDirectory, environment: {} }), /Invalid saved component identity/);
    await missing(join(project, '.env')); await missing(join(project, '.env.example')); await missing(join(project, '.gitignore'));
  }
  const project = await directory(t), stateDirectory = await savedComponent(project, 'orchestrator');
  await assert.rejects(seedEnvironment('orchestrator', project, { stateDirectory, environment: { WERK_ADMIN_TOKEN: tokenB } }), /must be distinct/);
  await missing(join(project, '.env'));
  await privateText(join(project, '.env'), 'WERK_ADMIN_TOKEN=' + tokenA + '\nWERK_ENROLLMENT_TOKEN=' + tokenB + '\n');
  await assert.rejects(loadEnvironment('orchestrator', project, { WERK_ADMIN_TOKEN: tokenB }), /must be distinct/);
});

test('explicit defaults override process options while project fallbacks defer to them', async t => {
  const project = await directory(t); await savedWorker(project, 'process-state', tokenB); await savedWorker(project, 'fallback-state', tokenA);
  const result = await seedEnvironment('worker', project, { environment: { WERK_WORKER_STATE_DIR: 'process-state', WERK_WORKER_CONFIG: 'process.json', WERK_WORKER_PORT: '4201' }, fallbacks: { 'state-dir': 'fallback-state', config: 'fallback.json', port: '4101' } });
  assert.equal(result.stateDirectory, join(project, 'process-state'));
  const values = parseEnvironment('worker', await readFile(join(project, '.env'), 'utf8'));
  assert.equal(values.WERK_WORKER_TOKEN === tokenB, true); assert.equal(values.WERK_WORKER_STATE_DIR, 'process-state'); assert.equal(values.WERK_WORKER_CONFIG, 'process.json'); assert.equal(values.WERK_WORKER_PORT, '4201');
  const explicit = await directory(t); await savedWorker(explicit, 'selected-state', tokenC);
  await seedEnvironment('worker', explicit, { environment: { WERK_WORKER_STATE_DIR: 'process-state', WERK_WORKER_PORT: '4201' }, defaults: { 'state-dir': 'selected-state', port: '4301' } });
  const selected = parseEnvironment('worker', await readFile(join(explicit, '.env'), 'utf8'));
  assert.equal(selected.WERK_WORKER_TOKEN === tokenC, true); assert.equal(selected.WERK_WORKER_STATE_DIR, 'selected-state'); assert.equal(selected.WERK_WORKER_PORT, '4301');
});

test('ignore setup adds only the rules a project lacks and writes the header once', async t => {
  const complete = await directory(t), ignorePath = join(complete, '.gitignore'), full = '# mine\r\n.env  \r\n!.env.example\r\nnode_modules/\r\n';
  await writeFile(ignorePath, full);
  assert.deepEqual((await seedEnvironment('worker', complete, { environment: {} })).ignoreAdded, []);
  assert.equal(await readFile(ignorePath, 'utf8'), full);
  const partial = await directory(t), partialPath = join(partial, '.gitignore');
  await writeFile(partialPath, 'dist/\n.env\n');
  assert.deepEqual((await seedEnvironment('worker', partial, { environment: {} })).ignoreAdded, ['!.env.example']);
  assert.equal(await readFile(partialPath, 'utf8'), 'dist/\n.env\n# Werk local environment\n!.env.example\n');
  assert.deepEqual((await seedEnvironment('worker', partial, { environment: {} })).ignoreAdded, []);
  const fresh = await directory(t);
  assert.deepEqual((await seedEnvironment('worker', fresh, { environment: {} })).ignoreAdded, ['.env', '!.env.example']);
  assert.equal(await readFile(join(fresh, '.gitignore'), 'utf8'), '# Werk local environment\n.env\n!.env.example\n');
  // Git keeps leading spaces as part of the pattern: " .env" does not ignore the generated credentials file.
  const indented = await directory(t), indentedPath = join(indented, '.gitignore');
  await writeFile(indentedPath, ' .env\r\n!.env.example\r\n');
  assert.deepEqual((await seedEnvironment('worker', indented, { environment: {} })).ignoreAdded, ['.env']);
  assert.equal(await readFile(indentedPath, 'utf8'), ' .env\r\n!.env.example\r\n# Werk local environment\r\n.env\r\n');
});
