import { testListeningAddress } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serveWebviewAsset } from '../../src/factory/dist/shared/http/webview-assets.js';

test('compiled webview assets are public, local, typed, bounded and never an HTML fallback', async t => {
  const directory=await mkdtemp(join(tmpdir(),'werk-view-assets-'));await mkdir(join(directory,'assets'));
  await writeFile(join(directory,'assets','app-deadbeef.js'),'export const fixture=true;');
  await writeFile(join(directory,'assets','app-deadbeef.css'),'body{color:white}');
  await writeFile(join(directory,'private.json'),'private-fixture');
  const server=createServer(async(req,res)=>{if(await serveWebviewAsset(req,res,pathToFileURL(directory+'/')))return;res.writeHead(401);res.end('API authorization required');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',() => resolve(undefined)));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+testListeningAddress(server).port;
  for(const [file,type]of[['app-deadbeef.js','text/javascript'],['app-deadbeef.css','text/css']]){
    const r=await fetch(base+'/assets/'+file);assert.equal(r.status,200);assert.ok(r.headers.get('content-type').startsWith(type));assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.match(r.headers.get('cache-control'),/immutable/);
    const head=await fetch(base+'/assets/'+file,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  }
  for(const path of ['/assets/missing.js','/assets/private.json','/assets/%2e%2e%2fprivate.json','/assets/app-deadbeef.js?extra=1']){const r=await fetch(base+path);assert.equal(r.status,404);assert.doesNotMatch(await r.text(),/private-fixture|<html/);}
  assert.equal((await fetch(base+'/assets/app-deadbeef.js',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/v1/access')).status,401);
  if(process.platform!=='win32'){await symlink(join(directory,'private.json'),join(directory,'assets','linked.js'));assert.equal((await fetch(base+'/assets/linked.js')).status,404);}
});
