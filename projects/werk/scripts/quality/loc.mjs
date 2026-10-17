import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';

function mask(text, start, end) {
  return text.slice(0, start) + text.slice(start, end).replace(/[^\r\n\u2028\u2029]/g, ' ') + text.slice(end);
}
function scriptCode(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) {
    throw new Error(ts.flattenDiagnosticMessageText(source.parseDiagnostics[0].messageText, '\n'));
  }
  const chunks = [];
  function visit(node) {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(source);
    if (children.length) children.forEach(visit);
    else if (node.kind <= ts.SyntaxKind.LastToken && node.kind !== ts.SyntaxKind.EndOfFileToken) chunks.push([node.getStart(source), node.end]);
  }
  visit(source);
  const result = text.split('').map((c) => /\s/.test(c) ? c : ' ');
  for (const [start, end] of chunks) for (let i = start; i < end; i++) result[i] = text[i];
  return result.join('');
}
function cssCode(text) {
  let result = text;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    if (quote) {
      if (text[i] === '\\') i++;
      else if (text[i] === quote) quote = '';
    } else if (text[i] === '"' || text[i] === "'") quote = text[i];
    else if (text.slice(i, i + 2) === '/*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unclosed CSS comment');
      result = mask(result, i, end + 2);
      i = end + 1;
    }
  }
  return result;
}
function vueCode(text, file) {
  const { descriptor, errors } = parse(text, { filename: file });
  if (errors.length) throw new Error(`${file}: ${errors.join(', ')}`);
  let result = text;
  const blocks = [descriptor.template, descriptor.script, descriptor.scriptSetup, ...descriptor.styles, ...descriptor.customBlocks].filter(Boolean);
  for (const block of blocks) {
    const { start, end } = block.loc;
    let code = block.content;
    if (block.type === 'script') code = scriptCode(code, file + '.' + (block.lang ?? 'js'));
    if (block.type === 'style') code = cssCode(code);
    if (block.type === 'template') {
      function comments(node) {
        if (node.type === 3) code = mask(code, node.loc.start.offset - start.offset, node.loc.end.offset - start.offset);
        node.children?.forEach(comments);
      }
      comments(block.ast);
    }
    result = result.slice(0, start.offset) + code + result.slice(end.offset);
  }
  // Only SFC-level comments remain outside the parsed blocks.
  for (const match of text.matchAll(/<!--[\s\S]*?-->/g)) {
    if (!blocks.some((block) => match.index >= block.loc.start.offset && match.index < block.loc.end.offset)) {
      result = mask(result, match.index, match.index + match[0].length);
    }
  }
  return result;
}
function htmlCode(text, file) {
  const prefix = '<template>\n';
  const { descriptor, errors } = parse(prefix + text + '\n</template>', { filename: file });
  if (errors.length) throw new Error(errors.join(', '));
  let result = text;
  function visit(node) {
    const start = node.loc.start.offset - prefix.length;
    const end = node.loc.end.offset - prefix.length;
    if (node.type === 3) result = mask(result, start, end);
    if (node.type === 1 && ['script', 'style'].includes(node.tag)) {
      for (const child of node.children) {
        const from = child.loc.start.offset - prefix.length;
        const to = child.loc.end.offset - prefix.length;
        const body = text.slice(from, to);
        const code = node.tag === 'style' ? cssCode(body) : scriptCode(body, file + '.js');
        result = result.slice(0, from) + code + result.slice(to);
      }
    } else node.children?.forEach(visit);
  }
  descriptor.template.ast.children.forEach(visit);
  return result;
}

/**
 * @param {string} text
 * @param {(binary: string, args: string[], options: import('node:child_process').SpawnSyncOptionsWithStringEncoding) => Pick<import('node:child_process').SpawnSyncReturns<string>, 'status' | 'error' | 'stdout' | 'stderr'>} [run]
 */
export function countPythonLines(text, run = spawnSync) {
  // Python's tokenizer distinguishes comments from quoted strings and f-strings.
  const program = [
    'import io, json, sys, tokenize',
    'source = sys.stdin.read()',
    'lines = source.splitlines()',
    'code = set()',
    'ignored = {tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT, tokenize.ENDMARKER}',
    'for token in tokenize.generate_tokens(io.StringIO(source).readline):',
    '    if token.type in ignored: continue',
    '    end = token.end[0] - (token.end[1] == 0)',
    '    for line in range(token.start[0], end + 1):',
    '        if lines[line - 1].strip(): code.add(line)',
    'print(json.dumps(len(code)))',
  ].join('\n');
  const failures = [];
  const probeTimeout = 15000;
  for (const binary of ['python3', 'python']) {
    // Windows Store aliases may exist but fail to launch an interpreter. Probe before tokenizing.
    const probe = run(binary, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', timeout: probeTimeout, maxBuffer: 4096, windowsHide: true });
    const version = Number(probe.stdout?.trim());
    if (probe.error || probe.status !== 0 || !Number.isInteger(version) || version < 3) {
      const timedOut = probe.error && 'code' in probe.error && probe.error.code === 'ETIMEDOUT';
      const reason = timedOut ? `startup timed out after ${probeTimeout / 1000} seconds`
        : probe.error?.message ?? (probe.status !== 0 ? `exit ${probe.status}` : `unsupported major version ${JSON.stringify(probe.stdout?.trim())}`);
      failures.push(`${binary}: ${reason}`);
      continue;
    }
    const result = run(binary, ['-c', program], { input: text, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error('Python LOC tokenization failed: ' + (result.error?.message ?? result.stderr));
    return JSON.parse(result.stdout);
  }
  throw new Error('Python 3 is required for the Python test LOC check; install python3 or python on PATH. ' + failures.join('; '));
}

export function countCodeLines(text, file) {
  if (file.endsWith('.py')) return countPythonLines(text);
  let code;
  if (file.endsWith('.vue')) code = vueCode(text, file);
  else if (file.endsWith('.css')) code = cssCode(text);
  else if (file.endsWith('.html')) code = htmlCode(text, file);
  else code = scriptCode(text, file);
  return code.split(/\r\n|[\n\r\u2028\u2029]/).filter((line) => line.trim()).length;
}
export async function inspectRepository(root) {
  const files = [];
  for (const [scope, limit] of [['src', 400], ['tests', 450]]) {
    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (['dist', 'public', 'node_modules', '.nuxt-ui'].includes(entry.name) || entry.name.startsWith('.build-')) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (/\.(?:[cm]?[jt]sx?|vue|css|html|py)$/.test(extname(path))) {
          let lines;
          try { lines = countCodeLines(await readFile(path, 'utf8'), path); }
          catch (error) { throw new Error(`${relative(root, path)}: ${error.message}`, { cause: error }); }
          files.push({ path: relative(root, path).split(sep).join('/'), lines, limit });
        }
      }
    };
    await walk(join(root, scope));
  }
  return { files: files.length, violations: files.filter((file) => file.lines > file.limit).sort((a, b) => a.path.localeCompare(b.path)) };
}

async function main(args) {
  let root = fileURLToPath(new URL('../../', import.meta.url));
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--root' && args[i + 1]) root = resolve(args[++i]);
    else throw new Error('Usage: node scripts/quality/loc.mjs [--root <directory>] [--json]');
  }
  const result = await inspectRepository(root);
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const item of result.violations) console.error(`${item.path}: ${item.lines} code lines exceeds ${item.limit}. Split by responsibility.`);
    console.log(`LOC: ${result.files} files checked; ${result.violations.length} exceed their limits (source 400, tests/helpers 450).`);
  }
  if (result.violations.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`LOC check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
