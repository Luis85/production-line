import test from 'node:test';
import assert from 'node:assert/strict';
import { factoryFleetOptions, validateFactorySecrets, bootstrapHierarchy } from '../../scripts/factory-fleet.mjs';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
test('factory fleet restores topology and validates all line/worker ports',()=>{
  const first=factoryFleetOptions([],{});assert.equal(first.workers,1);assert.equal(first.factoryPort,3100);
  assert.equal(factoryFleetOptions([],{}, {...first,alphaPort:3011}).alphaPort,3011);
  assert.equal(factoryFleetOptions(['--workers','2'],{}).workers,2);
  for(const env of [{WERK_FACTORY_PORT:'3001'},{WERK_FACTORY_STATUS_BASE:'3002'},{WERK_FACTORY_STATUS_BASE:'65535'},{WERK_LINE_A_PORT:'x'}])assert.throws(()=>factoryFleetOptions([],env));
  assert.throws(()=>factoryFleetOptions(['--workers','9'],{}));
});
test('factory secrets must be complete, distinct and safe to write to shell env',()=>{
  const keys=['WERK_FACTORY_ADMIN_TOKEN','WERK_LINE_ALPHA_TOKEN','WERK_LINE_BETA_TOKEN','WERK_ALPHA_ENROLLMENT_TOKEN','WERK_BETA_ENROLLMENT_TOKEN'];
  const values=Object.fromEntries(keys.map((key,index)=>[key,String(index).repeat(64)]));assert.deepEqual(validateFactorySecrets(values),values);
  assert.throws(()=>validateFactorySecrets({...values,WERK_LINE_BETA_TOKEN:values.WERK_LINE_ALPHA_TOKEN}));
  assert.throws(()=>validateFactorySecrets({...values,WERK_FACTORY_ADMIN_TOKEN:"'$(echo bad)"}));
});
test('hierarchy bootstrap is repeatable and never overwrites line settings',async()=>{
  const records={factories:[],lines:[]};let writes=0;
  const call=async(path,method='GET',body)=>{const key=path.split('/').at(-1);if(method==='GET')return {[key]:records[key]};writes++;records[key].push({...body});return body;};
  const config={alphaUrl:'http://127.0.0.1:3001',betaUrl:'http://127.0.0.1:3002'};
  await bootstrapHierarchy(call,config);assert.equal(writes,3);
  await bootstrapHierarchy(call,config);assert.equal(writes,3);
  records.lines[0].name='User label';await bootstrapHierarchy(call,config);assert.equal(records.lines[0].name,'User label');
  records.lines[0].orchestratorUrl='http://other:3000';await assert.rejects(bootstrapHierarchy(call,config),/settings differ/);assert.equal(writes,3);
});
test('factory distribution builds independently and includes its webview without YAML',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'werk-factory-build-')));
  try{
    await mkdir(join(root,'scripts'));await cp(new URL('../../scripts/build.mjs',import.meta.url),join(root,'scripts/build.mjs'));
    await writeFile(join(root,'package.json'),JSON.stringify({version:'0.1.0',engines:{node:'>=24 <25'}}));
    await cp(new URL('../../scripts/webviews.mjs',import.meta.url),join(root,'scripts/webviews.mjs'));
    await symlink(fileURLToPath(new URL('../../node_modules',import.meta.url)),join(root,'node_modules'),'junction');
    await mkdir(join(root,'src/shared'),{recursive:true});
    await mkdir(join(root,'src/factory'),{recursive:true});
    await writeFile(join(root,'src/factory/cli.ts'),'#!/usr/bin/env node\nconsole.log("factory");');
    for (const [app,title] of [['factory','Factory'],['guide','System guide']]) {
      const view=join(root,'src',app,'webview');await mkdir(view,{recursive:true});
      await writeFile(join(view,'index.html'),'<!doctype html><html><head><title>'+title+'</title></head><body><div id="app"></div><script type="module" src="/main.ts"></script></body></html>');
      await writeFile(join(view,'main.ts'),"import {createApp} from 'vue'; createApp({template:'<h1>"+title+"</h1>'}).mount('#app');");
    }
    await exec(process.execPath,[join(root,'scripts/build.mjs'),'factory','--dist-only']);
    const dest=join(root,'src/factory/dist');const manifest=JSON.parse(await readFile(join(dest,'package.json'),'utf8'));assert.equal(manifest.bin['werk-factory'],'factory/cli.js');
    assert.match(await readFile(join(dest,'factory/public/index.html'),'utf8'),/Factory/);
    assert.match(await readFile(join(dest,'factory/public/guide.html'),'utf8'),/System guide/);
    const page=await readFile(join(dest,'factory/public/index.html'),'utf8');
    const entry=/src="(\/assets\/[^" ]+\.js)"/.exec(page);assert.ok(entry,'Factory must ship a compiled module entry');
    assert.ok((await readFile(join(dest,'factory/public',entry[1]))).length>0);
    const guide=await readFile(join(dest,'factory/public/guide.html'),'utf8');
    assert.match(guide,/<script type="module">/);assert.doesNotMatch(guide,/<script[^>]+src=/);
    assert.equal(await readFile(join(dest,'package.json'),'utf8').then(value=>JSON.parse(value).name),'@werk/factory');
    assert.equal((await exec(process.execPath,[join(dest,'factory/cli.js')])).stdout.trim(),'factory');
  }finally{await rm(root,{recursive:true,force:true});}
});
