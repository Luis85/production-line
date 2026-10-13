import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { observeHttp } from '../../../src/orchestrator/dist/shared/http/observability.js';
import { statusServer } from '../../../src/worker/dist/worker/status/server.js';
import { captureServiceLogs, safeServiceLog } from '../../../scripts/runtime/service-logs.mjs';
import { logFile } from '../../../scripts/runtime/supervisor.mjs';
async function listening(handler) { const server=createServer(handler); await new Promise(ok=>server.listen(0,'127.0.0.1',ok)); return {server,url:`http://127.0.0.1:${server.address().port}`}; }
async function close(server){server.closeAllConnections();await new Promise(ok=>server.close(ok));}
test('request correlation and normalized diagnostics never include supplied secrets or thrown error text', async()=>{
 const events=[],secret='fixture-private-bearer-not-for-logs';
 const {server,url}=await listening(observeHttp('orchestrator',async(req,res)=>{if(req.url.startsWith('/fail'))throw Error(secret);res.writeHead(201);res.end('{}');},entry=>events.push(entry)));
 try{
  const response=await fetch(url+'/v1/tasks/'+secret+'?token='+secret,{headers:{Authorization:'Bearer '+secret,'X-Request-ID':secret}});
  assert.equal(response.status,201);assert.match(response.headers.get('x-request-id'),/^[a-f0-9-]{36}$/);assert.notEqual(response.headers.get('x-request-id'),secret);await response.text();
  const failure=await fetch(url+'/fail?password='+secret);assert.equal(failure.status,500);assert.deepEqual(await failure.json(),{error:'Internal server error'});
  await new Promise(ok=>setImmediate(ok));
  assert.ok(events.some(entry=>entry.route==='/v1/tasks/:id'&&entry.status===201));assert.ok(events.some(entry=>entry.event==='internal_error'));
  assert.equal(JSON.stringify(events).includes(secret),false);assert.ok(events.filter(entry=>entry.event==='request_finished').every(entry=>entry.durationMs>=0));
 }finally{await close(server)}
});
test('a failed diagnostic sink cannot break successful or failed HTTP responses',async()=>{
 const {server,url}=await listening(observeHttp('factory',(req,res)=>{if(req.url==='/error')throw Error('unprintable');res.end('ready');},()=>{throw Error('disk failed')}));
 try{assert.equal(await(await fetch(url)).text(),'ready');assert.equal((await fetch(url+'/error')).status,500)}finally{await close(server)}
});
test('worker health fails when disconnected while its read-only status remains available',async()=>{
 const state={state:'disconnected',mode:'mock',workerId:'worker-fixture',project:'demo'};
 const server=await statusServer(()=>state,'127.0.0.1',0),url=`http://127.0.0.1:${server.address().port}`;
 try{assert.equal((await fetch(url+'/healthz')).status,503);assert.equal((await fetch(url+'/status')).status,200);state.state='idle';assert.equal((await fetch(url+'/healthz')).status,200);state.state='stopping';assert.equal((await fetch(url+'/healthz')).status,503)}finally{await close(server)}
});
test('child log capture drops raw/oversized input and strips unrecognized fields before storage',async()=>{
 const stream=new PassThrough(),entries=[];captureServiceLogs(stream,entry=>entries.push(entry));
 const safe={schemaVersion:1,time:'2026-10-12T12:00:00.000Z',service:'worker',level:'warn',event:'connection_lost',secret:'do-not-forward'};
 stream.write('raw secret do-not-forward\n');stream.write('x'.repeat(20000));stream.write('\n');const text=JSON.stringify(safe);stream.write(text.slice(0,20));stream.write(text.slice(20)+'\n');stream.end();await new Promise(ok=>stream.once('end',ok));
 assert.equal(entries.length,1);assert.equal(entries[0].event,'connection_lost');assert.equal(JSON.stringify(entries).includes('do-not-forward'),false);
});
test('runtime logs rotate while running and refuse oversized records and symlink targets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'werk-log-bound-'));let log;
 try{log=await logFile(root);await log.appendFile('a'.repeat(700000));await log.appendFile('b'.repeat(700000));assert.equal((await stat(join(root,'logs/runtime.jsonl'))).size,700000);assert.equal((await stat(join(root,'logs/runtime.jsonl.previous'))).size,700000);await assert.rejects(log.appendFile('x'.repeat(1048577)),/bound/);await log.close();log=undefined;
  assert.equal((await readFile(join(root,'logs/runtime.jsonl'),'utf8'))[0],'b');
  if(process.platform!=='win32'){await rm(join(root,'logs/runtime.jsonl'));await symlink(join(root,'logs/runtime.jsonl.previous'),join(root,'logs/runtime.jsonl'));await assert.rejects(logFile(root),/private regular/)}
 }finally{await log?.close();await rm(root,{recursive:true,force:true})}
});

test('current worker and context routes retain useful diagnostics through private runtime log filtering', async () => {
 const events = [], secret = 'private-task-identifier';
 const routes = new Map([
  ...['/api/access', '/api/providers/check', '/api/definitions'].map(path => [path, path]),
  ['/v1/iteration/tasks', '/v1/iteration/tasks'],
  ['/v1/worker/assignments/next', '/v1/worker/assignments/next'],
  ['/v1/worker/snapshots', '/v1/worker/snapshots'],
  ['/v1/tasks/' + secret + '/context', '/v1/tasks/:id/context'],
  ...['context', 'heartbeat', 'complete', 'abandon'].map(action => ['/v1/worker/tasks/' + secret + '/' + action, '/v1/worker/tasks/:id/' + action]),
  ['/v1/worker/tasks/' + secret + '/unknown', 'unmatched'],
 ]);
 const {server, url} = await listening(observeHttp('orchestrator', (_req, res) => { res.writeHead(409); res.end('{}'); }, entry => events.push(entry)));
 try {
  for (const [path, expected] of routes) {
   const response = await fetch(url + path + '?lease=' + secret, { headers: { Authorization: 'Bearer ' + secret } });
   assert.equal(response.status, 409); await response.text();
   const entry = events.at(-1); assert.equal(entry.route, expected);
   const retained = safeServiceLog(entry);
   assert.ok(retained, 'runtime must retain the normalized event');
   assert.equal(retained.route, expected);
  }
  assert.equal(JSON.stringify(events).includes(secret), false);
  assert.equal(safeServiceLog({ ...events[0], route: '/v1/worker/tasks/' + secret + '/complete' }), null);
 } finally { await close(server); }
});
