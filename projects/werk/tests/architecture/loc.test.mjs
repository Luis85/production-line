import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { countCodeLines, countPythonLines } from '../../scripts/quality/loc.mjs';

const checker = fileURLToPath(new URL('../../scripts/quality/loc.mjs', import.meta.url));

test('code line accounting excludes comments and preserves strings, regex, templates and mixed lines', () => {
  const source = [
    '// comment',
    '/** documentation',
    ' * @example const fake = true;',
    ' */',
    'export const url = "https://example.invalid/😀/*literal*/"; // comment',
    'export const pattern = /[/][*]not a comment[*][/]/;',
    '/* before */ export const value = 1; /* after',
    'only comment',
    '*/ export const next = 2;',
    'export const text = `',
    '// literal content',
    '/* literal content */',
    '',
    '`;',
  ].join('\r\n');
  assert.equal(countCodeLines(source, 'source.ts'), 8);
  assert.equal(countCodeLines('const a = 1;\rconst b = 2;\u2028const c = 3;\u2029const d = 4;', 'newlines.js'), 4);
  assert.equal(countCodeLines('// nothing\n/** still nothing */\n', 'empty.mjs'), 0);
  assert.equal(countCodeLines('export const node = <p>/* literal */</p>;', 'view.tsx'), 1);
});

test('Python uses tokens to preserve string and docstring contents while excluding actual comments', () => {
  assert.equal(countCodeLines('# comment\nvalue = "# literal" # comment\ntext = """\n# literal content\n"""\n', 'test.py'), 4);
});


test('Python selection falls back past unavailable aliases and old interpreters without hiding source errors', () => {
  for (const unavailable of [
    { status: 9009, stdout: '', stderr: 'Python was not found; install it from the Store.' },
    { status: 0, stdout: '2\n', stderr: '' },
    { status: null, stdout: '', stderr: '', error: Object.assign(Error('Not found'), { code: 'ENOENT' }) },
  ]) {
    const commands = [];
    assert.equal(countPythonLines('value = 1', (binary, args, options) => {
      commands.push(binary);
      if (binary === 'python3') return unavailable;
      if (args[1].includes('version_info')) return { status: 0, stdout: '3\n', stderr: '' };
      assert.equal(options.input, 'value = 1');
      assert.match(args[1], /tokenize\.generate_tokens/);
      return { status: 0, stdout: '1\n', stderr: '' };
    }), 1);
    assert.deepEqual(commands, ['python3', 'python', 'python']);
  }
  const commands = [];
  assert.throws(() => countPythonLines('broken = """', (binary, args) => {
    commands.push(binary);
    return args[1].includes('version_info')
      ? { status: 0, stdout: '3\n', stderr: '' }
      : { status: 1, stdout: '', stderr: 'TokenError: EOF in multi-line string' };
  }), /Python LOC tokenization failed: TokenError/);
  assert.deepEqual(commands, ['python3', 'python3'], 'Source errors from a usable interpreter must not retry another binary');
  assert.throws(() => countPythonLines('', () => ({ status: 9009, stdout: '', stderr: 'Unavailable' })), /Python 3 is required/);
});

test('Vue counts template, styles and TypeScript but excludes each language’s actual comments', () => {
  const source = [
    '<!-- outside',
    'comment -->',
    '<script setup lang="ts">',
    '/* script',
    'comment */',
    'const text = "<!-- literal -->"; // tail',
    '</script>',
    '<template>',
    '<!-- template',
    'comment -->',
    '<p title="<!-- literal -->">{{ text }}</p><!-- mixed -->',
    '</template>',
    '<style>',
    '/* css',
    'comment */',
    'p { content: "/* literal */"; } /* mixed */',
    '</style>',
  ].join('\n');
  assert.equal(countCodeLines(source, 'Example.vue'), 9);
  assert.equal(countCodeLines('/* first\nsecond */\np { background: url(https://example.invalid/x); }', 'theme.css'), 1);
  assert.equal(countCodeLines('<script>\n// only comment\nconst value = `\n<!-- literal -->\n`;\n</script>\n<style>\n/* comment */\np { color: red; }\n</style>', 'inline.html'), 8);
  assert.equal(countCodeLines('<!-- only\ncomment -->\n<p>Hello</p><!-- mixed -->', 'index.html'), 1);
});

test('LOC executable rejects oversized source and test helpers, accepts exact limits and ignores generated assets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'werk-loc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, content) => {
    const full = join(root, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  };
  const declarations = count => Array.from({ length: count }, (_, i) => `const value${i} = ${i};`).join('\n');
  const comments = '\n/*\n' + 'a comment\n'.repeat(500) + '*/\n';
  await write('src/exact.ts', declarations(400) + comments);
  await write('tests/support/helper.cjs', declarations(450) + comments);
  for (const directory of ['dist', 'public', '.nuxt-ui', 'node_modules', '.build-preview']) {
    await write(`src/${directory}/generated.ts`, declarations(700));
  }
  const invoke = () => spawnSync(process.execPath, [checker, '--root', root, '--json'], { encoding: 'utf8', timeout: 10000 });
  const accepted = invoke();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), { files: 2, violations: [] });
  await write('src/exact.ts', declarations(401) + comments);
  await write('tests/support/helper.cjs', declarations(451) + comments);
  const rejected = invoke();
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.deepEqual(JSON.parse(rejected.stdout).violations, [
    { path: 'src/exact.ts', lines: 401, limit: 400 },
    { path: 'tests/support/helper.cjs', lines: 451, limit: 450 },
  ]);
  await write('src/broken.ts', 'const =');
  const invalid = invoke();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /LOC check failed: src[/\\]broken.ts:/);
  assert.equal(invalid.stdout, '', 'Unparseable source must never publish a passing or partial count');
});
