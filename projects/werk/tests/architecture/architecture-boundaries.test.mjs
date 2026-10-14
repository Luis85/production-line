import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { parse as parseVue } from '@vue/compiler-sfc';
import { DomainError, ValidationError } from '../../src/orchestrator/dist/shared/errors.js';
import { ApiError, httpStatus, isExpectedError } from '../../src/orchestrator/dist/shared/http/errors.js';
import { taskInput } from '../../src/orchestrator/dist/shared/validation.js';
import { fail } from '../../src/orchestrator/dist/shared/cli.js';

const src = fileURLToPath(new URL('../../src/', import.meta.url));
async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes:true})) {
    if (['dist','node_modules','public'].includes(entry.name) || entry.name.startsWith('.')) continue;
    const path = join(directory,entry.name);
    if(entry.isDirectory()) files.push(...await sourceFiles(path));
    else if(/\.(?:ts|m?js|vue)$/.test(entry.name)) files.push(path);
  }
  return files;
}
function references(file, contents) {
  if(file.endsWith('.vue')) { const parsed=parseVue(contents,{filename:file});assert.deepEqual(parsed.errors,[],file);contents=[parsed.descriptor.script?.content,parsed.descriptor.scriptSetup?.content].filter(Boolean).join('\n'); }
  const tree=ts.createSourceFile(file,contents,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const values=[];
  const visit=node=>{
    if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))values.push(node.moduleSpecifier.text);
    if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0]))values.push(node.arguments[0].text);
    if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteral(node.argument.literal))values.push(node.argument.literal.text);
    ts.forEachChild(node,visit);
  };
  visit(tree);
  return values;
}
async function dependencyGraph() {
  const graph=new Map();
  for(const path of await sourceFiles(src))graph.set(path,references(path,await readFile(path,'utf8')));
  return graph;
}
function localTarget(file,specifier) {
  return specifier.startsWith('.')?resolve(dirname(file),specifier.replace(/\.js$/,'.ts')):null;
}
test('source packages do not import sibling application internals',async()=>{
  const graph=await dependencyGraph();
  for(const [file,dependencies] of graph) {
    const owner=relative(src,file).split(sep)[0];
    for(const dependency of dependencies) {
      const target=localTarget(file,dependency);
      if(!target)continue;
      // The build entry may call the repository's shared bundler, never sibling runtime code.
      if(file === join(src,'worker','webview','vite.config.mjs') && target === resolve(src,'../scripts/webviews.mjs')) continue;
      const targetOwner=relative(src,target).split(sep)[0];
      const allowed=owner==='shared'?['shared']:[owner,'shared'];
      assert.ok(allowed.includes(targetOwner),`${relative(src,file)} imports forbidden ${dependency}`);
    }
  }
});
test('pure shared contracts have no direct or transitive transport/runtime dependency',async()=>{
  const graph=await dependencyGraph();
  const pure=new Set(['domain.ts','context.ts','contracts.ts','validation.ts','errors.ts','snapshots.ts','request-gate.ts','protocol.ts','html.ts','wiki.ts','factory.ts','capabilities.ts'].map(name=>join(src,'shared',name)));
  for(const root of pure) {
    const pending=[root],visited=new Set();
    while(pending.length) {
      const file=pending.pop();if(visited.has(file))continue;visited.add(file);
      assert.ok(graph.has(file),`Missing pure module ${relative(src,file)}`);
      for(const dependency of graph.get(file)) {
        const target=localTarget(file,dependency);
        assert.ok(target&&pure.has(target),`${relative(src,root)} depends on adapter/runtime via ${relative(src,file)} → ${dependency}`);
        pending.push(target);
      }
    }
  }
});
test('dependency checks include reexports, dynamic imports and import types',()=>{
  const values=references('fixture.ts',"export {x} from './a.js'; import('./b.js'); type C = import('./c.js').C; import type {D} from './d.js';");
  assert.deepEqual(values,['./a.js','./b.js','./c.js','./d.js']);
});
test('domain failures retain semantic identity and HTTP conversion stays in the adapter',()=>{
  assert.throws(()=>taskInput(null),error=>error instanceof ValidationError&&error.code==='invalid_input'&&!('status' in error));
  const expected={invalid_input:400,unauthorized:401,forbidden:403,not_found:404,conflict:409,too_large:413,unsupported_media_type:415,unavailable:503,internal:500};
  for(const [code,status] of Object.entries(expected)) {
    const failure=new DomainError(code,'Failure');assert.equal(httpStatus(failure),status);assert.equal(isExpectedError(failure),true);
  }
  assert.equal(httpStatus(new ApiError(429,'Quota')),429);
  assert.equal(httpStatus(new Error('Unexpected')),500);
  assert.equal(isExpectedError(new Error('Unexpected')),false);
});
test('CLI maps semantic input failures and remote HTTP failures to documented exit codes',()=>{
  const originalError=console.error,originalExit=process.exitCode;const messages=[];console.error=value=>messages.push(JSON.parse(value));
  try {
    for(const error of [new ValidationError('Bad task'),new DomainError('conflict','State changed'),new ApiError(401,'Authentication')]){fail(error);assert.equal(process.exitCode,2);}
    for(const error of [new DomainError('unavailable','Unavailable'),new DomainError('internal','Internal'),new ApiError(502,'Remote failure'),new Error('Unexpected')]){fail(error);assert.equal(process.exitCode,1);}
    assert.equal(messages.length,7);assert.deepEqual(messages[0],{error:'Bad task'});
  } finally {console.error=originalError;process.exitCode=originalExit;}
});

test('Vue setup and ordinary scripts both participate in application dependency boundaries',()=>{
  const source='<script lang="ts">import {a} from "../factory/private.js";<'+ '/script><script setup lang="ts">import type {B} from "../worker/private.js";<'+ '/script><template><p>View</p></template>';
  assert.deepEqual(references('Fixture.vue',source),['../factory/private.js','../worker/private.js']);
});
