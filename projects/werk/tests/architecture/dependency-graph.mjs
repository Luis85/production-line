import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse as parseVue } from '@vue/compiler-sfc';

export async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['dist', 'node_modules', 'public'].includes(entry.name) || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:[cm]?[jt]sx?|vue)$/.test(entry.name)) files.push(path);
  }
  return files;
}

/** Static edges, including type-only edges; computed imports remain explicit unresolved edges. */
export function references(file, contents) {
  if (file.endsWith('.vue')) {
    const parsed = parseVue(contents, { filename: file });
    if (parsed.errors.length) throw Error(`Cannot parse ${file}: ${parsed.errors.join(', ')}`);
    return [parsed.descriptor.script, parsed.descriptor.scriptSetup].filter(Boolean).flatMap(script =>
      references(file + '.ts', script.content).map(edge => ({ ...edge, line: edge.line + script.loc.start.line - 1 })));
  }
  const tree = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const values = [], requireFactories = new Set(), requireNames = new Set(['require']);
  const walk = visit => { const next = node => { visit(node); ts.forEachChild(node, next); }; next(tree); };
  walk(node => {
    if (ts.isImportDeclaration(node) && ['node:module', 'module'].includes(node.moduleSpecifier.text)) {
      for (const element of node.importClause?.namedBindings?.elements ?? []) {
        if ((element.propertyName ?? element.name).text === 'createRequire') requireFactories.add(element.name.text);
      }
    }
  });
  walk(node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) && requireFactories.has(node.initializer.expression.text)) requireNames.add(node.name.text);
  });
  const add = (node, value, kind, typeOnly = false) => values.push({
    specifier: value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) ? value.text : null,
    kind, typeOnly, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
  });
  walk(node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
      const typeOnly = Boolean(node.isTypeOnly || node.importClause?.isTypeOnly ||
        (!node.importClause?.name && bindings?.elements?.length && bindings.elements.every(item => item.isTypeOnly)));
      add(node, node.moduleSpecifier, ts.isImportDeclaration(node) ? 'import' : 'export', typeOnly);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node, node.moduleReference.expression, 'require', node.isTypeOnly);
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0], 'dynamic-import');
      else if (ts.isIdentifier(node.expression) && requireNames.has(node.expression.text)) add(node, node.arguments[0], 'require');
    }
    if (ts.isImportTypeNode(node)) add(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : null, 'import-type', true);
  });
  return values;
}

export async function dependencyGraph(directories) {
  const graph = new Map();
  for (const directory of directories) for (const file of await sourceFiles(directory)) graph.set(file, references(file, await readFile(file, 'utf8')));
  return graph;
}

export function resolveDependency(file, specifier, graph, { sourceRoot, aliases = {} }) {
  if (specifier === null) return null;
  let target;
  if (specifier.startsWith('.')) target = resolve(dirname(file), specifier);
  else if (isAbsolute(specifier)) target = resolve(specifier);
  else if (specifier.startsWith('file:')) {
    try { target = resolve(fileURLToPath(specifier)); } catch { return null; }
  }
  else {
    const aliasesWithPackages = { ...Object.fromEntries(['factory', 'orchestrator', 'worker', 'shared'].map(name => ['@werk/' + name, join(sourceRoot, name)])), ...aliases };
    for (const [alias, directory] of Object.entries(aliasesWithPackages).sort(([a], [b]) => b.length - a.length)) {
      if (specifier === alias || specifier.startsWith(alias + '/')) { target = resolve(directory, specifier.slice(alias.length).replace(/^\//, '')); break; }
    }
  }
  if (!target) return null;
  const candidates = [target, target.replace(/\.(?:m?js|cjs)$/, '.ts'), target + '.ts', target + '.js', join(target, 'index.ts'), join(target, 'index.js')];
  return candidates.find(candidate => graph.has(candidate)) ?? target;
}

const inside = (root, file) => file === root || file.startsWith(root + sep);
const normalized = value => value.replaceAll(sep, '/');

/** Returns violations so fixture tests exercise the same policies as the real source scan. */
export function boundaryViolations(graph, { sourceRoot, aliases = {}, pureShared = [], applicationRoots = [], exceptions = [] }) {
  sourceRoot = resolve(sourceRoot);
  const pure = new Set(pureShared.map(name => join(sourceRoot, 'shared', name))), failures = [];
  const options = { sourceRoot, aliases };
  const fail = (file, edge, rule) => failures.push({ file: normalized(relative(sourceRoot, file)), line: edge.line, specifier: edge.specifier, rule });
  for (const [file, edges] of graph) {
    const owner = relative(sourceRoot, file).split(sep)[0];
    const application = applicationRoots.some(root => inside(root, file));
    for (const edge of edges) {
      const target = resolveDependency(file, edge.specifier, graph, options);
      if (exceptions.some(([from, to]) => from === file && to === target)) continue;
      if (inside(sourceRoot, file) && target) {
        const targetOwner = relative(sourceRoot, target).split(sep)[0];
        if (!(owner === 'shared' ? ['shared'] : [owner, 'shared']).includes(targetOwner)) fail(file, edge, 'sibling-package');
      }
      if (application) {
        if (edge.specifier === null) fail(file, edge, 'application-computed-dependency');
        else if (target && !applicationRoots.some(root => inside(root, target)) && !inside(join(sourceRoot, 'shared'), target)) fail(file, edge, 'application-adapter');
        else if (target && inside(join(sourceRoot, 'shared'), target) && !pure.has(target)) fail(file, edge, 'application-shared-adapter');
        else if (!target && !['node:crypto', 'node:path', 'node:timers/promises', 'yaml'].includes(edge.specifier)) fail(file, edge, 'application-external-adapter');
      }
    }
  }
  for (const root of pure) {
    const pending = [root], visited = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      if (!graph.has(file)) { fail(root, { line: 1, specifier: file }, 'missing-pure-module'); continue; }
      for (const edge of graph.get(file)) {
        const target = resolveDependency(file, edge.specifier, graph, options);
        if (!target || !pure.has(target)) fail(file, edge, 'pure-contract-adapter');
        else pending.push(target);
      }
    }
  }
  return failures;
}
