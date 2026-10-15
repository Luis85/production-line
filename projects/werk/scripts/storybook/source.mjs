import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, posix } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';

const inputs = ['src', '.storybook', 'storybook', 'scripts/storybook', 'package.json', 'package-lock.json'];
const slash = path => path.replaceAll('\\', '/');
export async function sourceFiles(root) {
  const files = [];
  async function walk(path) {
    const stat = await lstat(resolve(root, path));
    if (stat.isSymbolicLink()) throw Error(`Storybook input must not be a symlink: ${path}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(resolve(root, path))).sort()) {
        if (['node_modules', 'dist', '.nuxt-ui'].includes(name)) continue;
        await walk(`${path}/${name}`);
      }
    } else if (stat.isFile()) files.push(path);
  }
  for (const input of inputs) await walk(input);
  return files.sort();
}
export async function sourceDigest(root) {
  const hash = createHash('sha256');
  for (const file of await sourceFiles(root)) {
    const bytes = await readFile(resolve(root, file));
    hash.update(`${file}\0${bytes.length}\0`); hash.update(bytes); hash.update('\0');
  }
  return hash.digest('hex');
}
export function sourceCommit(root) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}
export function componentContract(text, path) {
  const { descriptor, errors } = parse(text, { filename: path });
  if (errors.length) throw Error(`Invalid Vue source ${path}: ${errors.join('; ')}`);
  const imports = new Set(), props = [], events = [];
  for (const block of [descriptor.script, descriptor.scriptSetup].filter(Boolean)) {
    const source = ts.createSourceFile(path + '.ts', block.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    function visit(node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        if (spec.startsWith('.') && spec.endsWith('.vue')) imports.add(posix.normalize(posix.join(posix.dirname(path), spec)));
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const output = node.expression.text === 'defineProps' ? props : node.expression.text === 'defineEmits' ? events : null;
        if (output) {
          // Keep the real TypeScript contract, including imported aliases and unions.
          for (const arg of node.typeArguments ?? []) output.push(arg.getText(source));
          for (const arg of node.arguments) output.push(arg.getText(source));
        }
        if (node.expression.text === 'defineModel') {
          const named = node.arguments[0] && ts.isStringLiteral(node.arguments[0]);
          const name = named ? node.arguments[0].text : 'modelValue';
          const options = node.arguments[named ? 1 : 0];
          const required = options && ts.isObjectLiteralExpression(options) && options.properties.some(property =>
            ts.isPropertyAssignment(property) && property.name.getText(source) === 'required' && property.initializer.kind === ts.SyntaxKind.TrueKeyword);
          const type = node.typeArguments?.[0]?.getText(source) ?? 'unknown';
          props.push(`{ ${JSON.stringify(name)}${required ? '' : '?'}: ${type} }`);
          events.push(`{ ${JSON.stringify('update:' + name)}: [value: ${type}] }`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const area = path.split('/')[1];
  const app = path.includes('/concept/') ? 'Concept' : area[0].toUpperCase() + area.slice(1);
  return { path, name: posix.basename(path, '.vue'), app, imports: [...imports].sort(), props, events };
}
/** Only router records declare routes; redirect targets and arbitrary path data do not. */
export function routeContract(code, file) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const routes = [], constructors = new Set(['createRouter']);
  const property = (object, name) => object.properties.find(item => ts.isPropertyAssignment(item)
    && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'vue-router') continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const specifier of bindings.elements) {
      if ((specifier.propertyName ?? specifier.name).text === 'createRouter') constructors.add(specifier.name.text);
    }
  }
  function records(array, parent = '/') {
    if (!array || !ts.isArrayLiteralExpression(array)) throw Error(`Router records must be an array literal in ${file}`);
    for (const record of array.elements) {
      if (!ts.isObjectLiteralExpression(record)) throw Error(`Unsupported router record in ${file}`);
      const path = property(record, 'path');
      if (!path || !ts.isStringLiteral(path.initializer)) throw Error(`Router path must be a string literal in ${file}`);
      const value = path.initializer.text;
      const fullPath = value.startsWith('/') ? value : posix.join(parent, value);
      const redirect = property(record, 'redirect');
      routes.push({ app: file.split('/')[1], path: fullPath, source: file, ...(redirect ? { redirect: redirect.initializer.getText(source) } : {}) });
      const children = property(record, 'children');
      if (children) records(children.initializer, fullPath);
    }
  }
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && constructors.has(node.expression.text)) {
      const options = node.arguments[0];
      if (!options || !ts.isObjectLiteralExpression(options)) throw Error(`Router options must be an object literal in ${file}`);
      const declared = property(options, 'routes');
      if (!declared) throw Error(`Router routes are missing in ${file}`);
      records(declared.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return routes;
}
export async function sourceInventory(root) {
  const files = await sourceFiles(root);
  const components = [];
  for (const file of files.filter(file => file.endsWith('.vue'))) components.push(componentContract(await readFile(resolve(root, file), 'utf8'), file));
  const routes = [];
  for (const file of files.filter(file => /src\/(worker|factory|orchestrator)\/webview\/main\.ts$/.test(file))) {
    const code = await readFile(resolve(root, file), 'utf8');
    routes.push(...routeContract(code, file));
  }
  const packages = [];
  for (const file of files.filter(file => /^src\/[^/]+\/package\.json$/.test(file))) {
    const pkg = JSON.parse(await readFile(resolve(root, file), 'utf8'));
    packages.push({ name: pkg.name, source: file, directory: slash(relative(root, dirname(resolve(root, file)))) });
  }
  const version = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
  return { schemaVersion: 1, version, commit: sourceCommit(root), sourceDigest: await sourceDigest(root), components, routes, system: { packages, flows: [
    { from: 'Factory', to: 'Orchestrator', purpose: 'Route an intake request to a production line' },
    { from: 'Orchestrator', to: 'Worker', purpose: 'Dispatch a queued task to a matching worker' },
    { from: 'Worker', to: 'Model provider', purpose: 'Execute the selected model within request controls' },
    { from: 'Worker', to: 'Human review', purpose: 'Resolve checkpoints and review file changes' },
    { from: 'Worker', to: 'Orchestrator', purpose: 'Report the attempt outcome and evidence' },
  ], note: 'UI fixtures illustrate contracts; screenshots are not evidence of live model execution. The Worker can also accept tasks independently.' } };
}
