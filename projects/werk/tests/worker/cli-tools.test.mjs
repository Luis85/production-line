import { cleanup } from './fixture-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkCliArguments, cliToolDescription, CliArgumentError } from '../../src/worker/dist/worker/application/cli-tool-policy.js';
import { defaultToolPolicy, publicToolPolicy, updateToolPolicy, validateToolPolicy } from '../../src/worker/dist/worker/application/tool-policy.js';
import { WorkerSettings } from '../../src/worker/dist/worker/infrastructure/settings.js';
import { createToolRuntime } from '../../src/worker/dist/worker/infrastructure/tool-runtime.js';
import { toolAccessBody, workerBody } from '../../scripts/runtime/portable/worker-commands.mjs';
import { commands } from '../../scripts/runtime/portable/commands.mjs';

const harness = (extra = {}) => ({
  id: 'harness', name: 'Project harness', description: 'Reads the project backlog.', enabled: true,
  executable: process.execPath, args: ['bin/harness.mjs'],
  commands: [{ command: 'help' }, { command: 'check' }, { command: 'backlog context' }, { command: 'backlog set', requireOneOf: ['--dry-run'] }, { command: 'codegen', requireOneOf: ['--check', '--dry-run'] }, { command: 'eol', refusedOptions: ['--fix', '--hook'] }, { command: 'fail' }, { command: 'flood' }],
  refusedOptions: ['--root', '--config', '--out', '-o'], ...extra,
});
const update = (tools, policy = defaultToolPolicy()) => updateToolPolicy(policy, { expectedRevision: policy.revision, builtins: { ...policy.builtins, cliTools: tools }, mcp: [] });
const tool = (extra) => update([harness(extra)]).builtins.cliTools[0];
const refused = (args, pattern, configured = tool()) => assert.throws(() => checkCliArguments(configured, args), error => error instanceof CliArgumentError && (!pattern || pattern.test(error.message)), JSON.stringify(args));
async function directory(t) { const path = await realpath(await mkdtemp(join(tmpdir(), 'werk-cli-tools-'))); cleanup(t, () => rm(path, { recursive: true, force: true })); return path; }

test('CLI tool grants default off, normalize optional limits and accept documents saved before CLI tools', () => {
  assert.deepEqual(defaultToolPolicy().builtins.cliTools, []);
  const legacy = validateToolPolicy({ schemaVersion: 1, revision: 4, builtins: { files: false, commands: [], webOrigins: [] }, mcp: [] });
  assert.deepEqual(legacy.builtins.cliTools, [], 'a missing list grants nothing');
  const saved = tool();
  assert.deepEqual({ maxArgs: saved.maxArgs, maxArgLength: saved.maxArgLength, outputKiB: saved.outputKiB }, { maxArgs: 24, maxArgLength: 500, outputKiB: 32 });
  assert.deepEqual(saved.commands.find(rule => rule.command === 'backlog set'), { command: 'backlog set', requireOneOf: ['--dry-run'], refusedOptions: [] });
  assert.deepEqual(validateToolPolicy(JSON.parse(JSON.stringify(update([harness()])))).builtins.cliTools[0], saved, 'stored policy validates unchanged');
  const disabled = update([harness({ enabled: false })]);
  assert.equal(disabled.builtins.cliTools[0].enabled, false);
});

test('CLI tool validation rejects unsafe or ambiguous configuration with clear errors', () => {
  const cases = [
    [{ executable: 'node' }, /absolute path/],
    [{ executable: 'C:\\tools\\project.cmd' }, /\.bat or \.cmd/],
    [{ executable: 'C:\\tools\\project.BAT' }, /\.bat or \.cmd/],
    [{ id: 'x'.repeat(49) }, /CLI tool ID/],
    [{ id: 'has space' }, /letters, digits/],
    [{ commands: [] }, /Allow 1–64 commands/],
    [{ commands: [{ command: 'backlog context extra' }] }, /one or two words/],
    [{ commands: [{ command: 'check;rm' }] }, /one or two words/],
    [{ commands: [{ command: 'check' }, { command: 'check' }] }, /once/],
    [{ commands: [{ command: '--root' }] }, /refused option/],
    [{ commands: [{ command: 'set', requireOneOf: ['--root'] }] }, /also refused/],
    [{ commands: [{ command: 'set', requireOneOf: ['dry-run'] }] }, /option names/],
    [{ refusedOptions: ['--out=/tmp'] }, /option names/],
    [{ maxArgs: 65 }, /Maximum arguments/],
    [{ outputKiB: 0 }, /Output limit/],
    [{ shell: true }, /documented CLI tool fields/],
    [{ description: 'x'.repeat(1001) }, /description/],
    [{ commands: Array.from({ length: 64 }, (_, i) => ({ command: 'c'.repeat(50) + i + ' ' + 'd'.repeat(60), refusedOptions: ['--' + 'e'.repeat(60)] })) }, /generated description/],
  ];
  for (const [extra, pattern] of cases) assert.throws(() => update([harness(extra)]), pattern, JSON.stringify(extra).slice(0, 80));
  assert.throws(() => update([harness(), harness()]), /IDs must be unique/);
  assert.throws(() => update(Array.from({ length: 9 }, (_, i) => harness({ id: 'tool-' + i }))), /at most 8/);
  const files = defaultToolPolicy(); files.builtins.files = true;
  const definitions = Array.from({ length: 61 }, (_, i) => ({ name: 'tool_' + i, description: '', inputSchema: { type: 'object' } }));
  assert.throws(() => validateToolPolicy({ ...files, builtins: { ...files.builtins, cliTools: [harness()] }, mcp: [{ id: 'm', name: 'M', transport: 'http', enabled: true, command: '', args: [], url: 'https://mcp.example.test/', secretEnv: '', secret: '', allowedTools: definitions.map(item => item.name), discoveredTools: definitions }] }), /at most 64/, 'each enabled CLI tool counts toward the model tool limit');
});

test('argument policy accepts allowed commands and refuses paths, options and missing preview flags', () => {
  const configured = tool();
  for (const args of [['help'], ['check', '--json'], ['backlog', 'context', 'LACF-REQ-012', '--format', 'summary'], ['backlog', 'context', 'docs/spec file.md'], ['backlog', 'set', '--dry-run', 'ITEM', '--title', 'New title'], ['backlog', 'set', 'ITEM', '--dry-run'], ['backlog', 'set', '--title=x', '--dry-run'], ['codegen', '--check'], ['codegen', '--dry-run', '--check'], ['eol'], ['check', '--where=status:done'], ['check', '$HOME', '%PATH%', '; rm -rf .', '`id`', '|', '&&'], ['check', '-v'], ['check', '']])
    assert.deepEqual(checkCliArguments(configured, args).args, args, JSON.stringify(args));
  assert.equal(checkCliArguments(configured, ['backlog', 'set', '--dry-run']).rule.command, 'backlog set', 'the longest matching rule applies');
  refused([], /1–24 strings/); refused('help', /1–24 strings/); refused(Array(25).fill('help'), /1–24 strings/);
  refused(['help', 'x'.repeat(501)], /500 characters/); refused(['help', 7]); refused(['help', 'a\nb'], /control/); refused(['help', 'a\0b'], /control/); refused(['help', 'tab\there'], /control/);
  refused(['deploy'], /not an allowed command.*help, check/); refused(['backlog'], /not an allowed/); refused(['backlog', 'delete', '--dry-run'], /not an allowed/); refused(['Help'], /not an allowed/);
  refused(['check', '--'], /terminator/); refused(['backlog', 'set', 'ITEM', '--', '--dry-run'], /terminator/);
  for (const option of ['--root', '--root=.', '--config=x.json', '--out', '-o', '-ofile', '-xo', '-vo=x']) refused(['check', option], /not available/);
  refused(['eol', '--fix'], /for "eol"/); refused(['eol', '--hook=pre-commit'], /for "eol"/);
  assert.doesNotThrow(() => checkCliArguments(configured, ['check', '--fix']), 'rule-specific refusals do not apply to other commands');
  for (const value of ['/etc/passwd', 'C:\\Windows\\win.ini', 'c:/windows', 'C:relative', '\\Windows', '\\\\server\\share\\x', '//server/share', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', '..', '../outside', 'src/../../outside', '..\\outside', 'src\\..\\..\\x', '~', '~/notes', '~user/x', 'file:///etc/passwd', 'FILE:C:/x', '--input=/etc/passwd', '--input=C:\\x', '--input=../x', '-I/usr/include', '-IC:\\include', '@/tmp/args', '@C:\\args.txt'])
    refused(['check', value], /relative to the task worktree/);
  refused(['backlog', 'set', 'ITEM'], /only available with --dry-run/);
  refused(['backlog', 'set', 'ITEM', '--title', '--dry-run'], /directly after the command/, configured);
  refused(['backlog', 'set', '--dry-run=false', 'ITEM'], /only available/);
  refused(['backlog', 'set', 'ITEM', '--DRY-RUN'], /only available/);
  refused(['codegen'], /--check or --dry-run/);
  const short = tool({ maxArgs: 2, maxArgLength: 4 });
  refused(['help', 'help', 'help'], /1–2 strings/, short); refused(['check', 'abcde'], /4 characters/, short);
});

test('model-facing description and schema list the contract without host paths or fixed arguments', () => {
  const configured = tool({ executable: process.platform === 'win32' ? 'C:\\Users\\operator\\private\\node.exe' : '/home/operator/private/node', args: ['private/harness-entry.mjs'] });
  const text = cliToolDescription(configured);
  assert.match(text, /^\[Project harness\] Reads the project backlog\./);
  assert.match(text, /"help", "check", "backlog context"/); assert.match(text, /"backlog set" with --dry-run/); assert.match(text, /"codegen" with --check or --dry-run/);
  assert.match(text, /Refused options: --root, --config, --out, -o\./); assert.match(text, /"eol" refuses --fix, --hook/); assert.match(text, /limited to 32 KiB/);
  assert.doesNotMatch(text, /private|harness-entry|node\.exe|\/home\//);
});

const script = String.raw`
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync('ran.txt', JSON.stringify(args));
if (args[0] === 'fail') { console.error('fixture failure'); process.exitCode = 3; }
if (args[0] === 'flood') process.stdout.write('"'.repeat(200000));
else if (args[0] !== 'fail') console.log('\uFEFF\x1b[32m' + JSON.stringify({ args, cwd: process.cwd(), secret: process.env.WERK_TEST_SECRET ?? null, color: process.env.NO_COLOR ?? null }) + '\x1b[0m\r');
`;
async function runtimeFixture(t, mutate = () => {}) {
  const root = await directory(t), worktree = join(root, 'worktree');
  await mkdir(join(worktree, 'bin'), { recursive: true });
  await writeFile(join(worktree, 'bin', 'harness.mjs'), script);
  const policy = update([harness({ outputKiB: 4, truncationHint: 'Use --limit.' })]); mutate(policy);
  const runtime = createToolRuntime({ policy, currentRevision: () => policy.revision, directory: root, worktree });
  t.after(() => runtime.close());
  return { root, worktree, policy, runtime };
}
const signal = () => new AbortController().signal;

test('CLI tools run through the tool runtime in the task worktree without a shell, bounded and policy-checked', { timeout: 60000 }, async t => {
  const previous = process.env.WERK_TEST_SECRET; process.env.WERK_TEST_SECRET = 'host-only-secret';
  t.after(() => { if (previous === undefined) delete process.env.WERK_TEST_SECRET; else process.env.WERK_TEST_SECRET = previous; });
  const { root, worktree, policy, runtime } = await runtimeFixture(t);
  assert.deepEqual(runtime.manifest.tools.map(item => item.name), ['werk_cli_harness']);
  assert.deepEqual(runtime.manifest.tools[0].inputSchema.required, ['args']);
  assert.equal(JSON.stringify(runtime.manifest).includes(process.execPath), false, 'host paths never enter the dispatch manifest');

  const args = ['check', '; echo injected', '$HOME', '%PATH%', 'two words', ''];
  const result = await runtime.call('werk_cli_harness', { args }, signal());
  assert.equal(result.isError, undefined, result.content[0].text);
  const [status, line] = result.content[0].text.split('\n');
  assert.equal(status, 'exit: 0');
  assert.deepEqual(JSON.parse(line), { args, cwd: worktree, secret: null, color: '1' }, 'arguments arrive literally, BOM/ANSI/CR are removed and host secrets are not inherited');

  await rm(join(worktree, 'ran.txt'));
  for (const input of [{ args: ['check', '../outside'] }, { args: ['deploy'] }, { args: ['backlog', 'set', 'ITEM'] }, { args: ['check', '--root=.'] }, { args: ['check'], cwd: root }, { command: 'check' }]) {
    const denied = await runtime.call('werk_cli_harness', input, signal());
    assert.equal(denied.isError, true, JSON.stringify(input));
    assert.equal(denied.content[0].text.includes(root), false, 'refusals do not reveal host paths');
  }
  await assert.rejects(stat(join(worktree, 'ran.txt')), { code: 'ENOENT' }, 'refused calls never start the process');

  const failed = await runtime.call('werk_cli_harness', { args: ['fail'] }, signal());
  assert.equal(failed.isError, undefined); assert.match(failed.content[0].text, /^exit: 3\n\n\[stderr\]\nfixture failure/);
  const flood = await runtime.call('werk_cli_harness', { args: ['flood'] }, signal());
  assert.ok(Buffer.byteLength(flood.content[0].text) < 4 * 1024 + 200); assert.match(flood.content[0].text, /\[output truncated at 4 KiB\. Use --limit\.\]$/);
  assert.deepEqual(JSON.parse(await readFile(join(worktree, 'ran.txt'), 'utf8')), ['flood']);

  policy.revision++;
  await assert.rejects(runtime.call('werk_cli_harness', { args: ['help'] }, signal()), /permissions changed/);
});

test('CLI tools need a task worktree and an enabled grant', async t => {
  const { root, policy } = await runtimeFixture(t);
  const chat = createToolRuntime({ policy, currentRevision: () => policy.revision, directory: root });
  t.after(() => chat.close());
  assert.deepEqual(chat.manifest.tools, [], 'chat without a worktree has no CLI tools');
  const off = await runtimeFixture(t, value => { value.builtins.cliTools[0].enabled = false; });
  assert.deepEqual(off.runtime.manifest.tools, []);
  await assert.rejects(off.runtime.call('werk_cli_harness', { args: ['help'] }, signal()), /not granted/);
});

test('saved CLI grants persist privately and an empty list stays readable by earlier workers', async t => {
  const path = await directory(t), settings = new WorkerSettings(path); await settings.init();
  const base = settings.toolPolicy();
  await settings.updateToolAccess({ expectedRevision: base.revision, builtins: base.builtins, mcp: [] });
  assert.equal('cliTools' in JSON.parse(await readFile(join(path, 'tool-access.json'), 'utf8')).builtins, false);
  await settings.updateToolAccess({ expectedRevision: 1, builtins: { ...base.builtins, cliTools: [harness()] }, mcp: [] });
  assert.equal(JSON.parse(await readFile(join(path, 'tool-access.json'), 'utf8')).builtins.cliTools[0].id, 'harness');
  const reloaded = new WorkerSettings(path); await reloaded.init();
  assert.deepEqual(reloaded.toolPolicy().builtins.cliTools, settings.toolPolicy().builtins.cliTools);
  assert.equal(publicToolPolicy(reloaded.toolPolicy()).builtins.cliTools[0].executable, process.execPath);
});

test('tool-access CLI commands round-trip the redacted view and guard discovery with a revision', async () => {
  const catalog = commands('worker');
  assert.deepEqual([catalog['tool-access get'].method, catalog['tool-access set'].method, catalog['tool-access discover'].method], ['GET', 'POST', 'POST']);
  assert.equal(catalog['tool-access set'].mutating, true); assert.deepEqual(catalog['tool-access discover'].required, ['id', 'if-match']);
  const view = { schemaVersion: 1, revision: 7, builtins: { files: false, commands: [], cliTools: [harness()], webOrigins: [] }, mcp: [{ id: 'docs', name: 'Docs', transport: 'http', enabled: true, command: '', args: [], url: 'https://mcp.example.test/', secretEnv: '', hasSecret: true, allowedTools: ['search'], discoveredTools: [{ name: 'search' }] }], canEdit: true, saveBlockedReason: null, workerNode: process.execPath };
  const body = await workerBody(catalog['tool-access set'], view, {});
  assert.deepEqual(body, { expectedRevision: 7, builtins: view.builtins, mcp: [{ id: 'docs', name: 'Docs', transport: 'http', enabled: true, command: '', args: [], url: 'https://mcp.example.test/', secretEnv: '', allowedTools: ['search'] }] });
  assert.deepEqual(toolAccessBody({ expectedRevision: 2, builtins: {}, mcp: [] }), { expectedRevision: 2, builtins: {}, mcp: [] });
  assert.throws(() => toolAccessBody([]), /JSON object/); assert.throws(() => toolAccessBody({ builtins: {} }), /expectedRevision/);
  assert.deepEqual(await workerBody(catalog['tool-access discover'], undefined, { id: 'docs', 'if-match': '7' }), { id: 'docs', expectedRevision: 7 });
  await assert.rejects(workerBody(catalog['tool-access discover'], undefined, { id: 'docs', 'if-match': 'latest' }), /if-match/);
});
