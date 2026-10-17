import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { parse as parseVue } from '@vue/compiler-sfc';
import { scope } from '../mutation/scope.mjs';

const sourceRoots = ['src', 'scripts', 'tests', 'storybook', '.storybook'];
const sourceEntries = ['werk.mjs', 'stryker.config.mjs'];
const excluded = new Set(['dist', 'node_modules', 'public', '.nuxt-ui']);
const generated = /(?:^|\/)src\/(factory|orchestrator|worker)\/dist\/|(?:^|\/)\.mutation-build\//;

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return (await Promise.all(entries.filter(entry => !excluded.has(entry.name) && !entry.name.startsWith('.build-')).map(async entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.(?:[cm]?[jt]s|[jt]sx|vue)$/.test(entry.name) ? [path] : [];
  }))).flat();
}
function references(path, source) {
  if (path.endsWith('.vue')) {
    const parsed = parseVue(source, { filename: path });
    if (parsed.errors.length) throw Error(`Cannot parse ${path}: ${parsed.errors.join(', ')}`);
    return [parsed.descriptor.script, parsed.descriptor.scriptSetup].filter(Boolean).flatMap(script => references(path + '.ts', script.content));
  }
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true), values = [];
  const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
  const visit = node => {
    let value;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) value = literal(node.moduleSpecifier);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) value = literal(node.arguments[0]);
    else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') value = literal(node.arguments?.[0]);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) value = literal(node.argument.literal);
    // Bare paths resolved against a caller-supplied URL base are not module imports,
    // and cannot match the relative compiled-import allowances in .fallowrc.json.
    if (value !== undefined && /^[./]/.test(value) && generated.test(value)) values.push(value);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return values;
}

/** Validate the exact build mapping before Fallow ignores unavailable compiled artifacts. */
export function generatedImportSource(root, importer, specifier) {
  const target = relative(root, resolve(dirname(importer), specifier)).split(sep).join('/');
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw Error('Generated imports must be relative to their importing module.');
  const suffix = specifier.includes('/dist/') ? specifier.split('/dist/')[1] : specifier.split('.mutation-build/')[1];
  if (!suffix || suffix.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Generated import paths cannot traverse their build output.');
  // The build writes each app manifest from the root release package metadata.
  if (/^src\/(factory|orchestrator|worker)\/dist\/package\.json$/.test(target)) return 'package.json';
  const app = /^src\/(factory|orchestrator|worker)\/dist\/(factory|orchestrator|worker|shared)\/(.+)\.js$/.exec(target);
  if (app) {
    if (app[1] !== app[2] && app[2] !== 'shared') throw Error('An application archive contains only its own service and shared modules.');
    if (app[3].endsWith('.d') || app[3].split('/').some(part => excluded.has(part) || part === 'webview' || part.startsWith('.build-')))
      throw Error('This source is excluded from application compilation.');
    return `src/${app[2]}/${app[3]}.ts`;
  }
  const mutation = /^\.mutation-build\/(.+)\.js$/.exec(target);
  if (mutation) {
    const source = `src/${mutation[1]}.ts`;
    if (!scope.targets.includes(source)) throw Error('Mutation suite imports must name a configured mutation target.');
    return source;
  }
  throw Error('Generated import does not match an application or mutation build output inside this project.');
}

export async function verifyGeneratedImports(root) {
  let count = 0;
  const paths = (await Promise.all(sourceRoots.map(directory => files(join(root, directory))))).flat();
  for (const entry of sourceEntries) {
    const path = join(root, entry);
    if (await stat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; })) paths.push(path);
  }
  for (const path of paths) {
    for (const specifier of references(path, await readFile(path, 'utf8'))) {
      try {
        const source = generatedImportSource(root, path, specifier);
        if (!(await stat(join(root, source))).isFile()) throw Error('Source is not a regular file.');
        count++;
      } catch (error) { throw Error(`${relative(root, path)}: ${specifier}: ${error.message}`); }
    }
  }
  return count;
}
