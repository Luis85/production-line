import { testErrorMessage } from '../../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, chmod, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAccess, accessAuthorization, loadAccessFile } from '../../../src/orchestrator/dist/shared/http/access.js';
import { startServer } from '../../../src/orchestrator/dist/orchestrator/server.js';
import { startFactoryServer } from '../../../src/factory/dist/factory/server.js';
import { setup, createPrivate } from '../../../scripts/runtime/config.mjs';
import { accessCommand } from '../../../scripts/security/access.mjs';
import { main } from '../../../scripts/security/cli.mjs';
import { ingressProfile } from '../../../scripts/security/ingress.mjs';
import { configureAccessFile } from '../../../scripts/docker/access.mjs';
import { safeServiceLog } from '../../../scripts/runtime/service-logs.mjs';
const admin='a'.repeat(64), enrollment='b'.repeat(64), viewer='c'.repeat(64), operator='d'.repeat(64);
/** @type {import('../../../src/shared/http/access.ts').AccessDocument} */
const access={schemaVersion:1,principals:[{id:'observer',role:'viewer',token:viewer},{id:'maintainer',role:'operator',token:operator}]};
async function api(app,path,token,method='GET',body){return fetch(`http://127.0.0.1:${app.server.address().port}`+path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
test('named access validates bounded private configuration without echoing credentials',async()=>{
 assert.deepEqual(accessAuthorization(admin,access)(viewer),{id:'observer',role:'viewer'});
 assert.throws(()=>accessAuthorization(admin,access)(enrollment),/Valid access token/);
 assert.throws(()=>accessAuthorization(viewer,access),/Invalid private/);
 assert.throws(()=>accessAuthorization(admin,access,[viewer]),/Invalid private/);
 for(const value of [{...access,extra:true},{schemaVersion:1,principals:[...access.principals,access.principals[0]]},{schemaVersion:1,principals:[{id:'legacy-admin',role:'viewer',token:viewer}]}]) assert.throws(()=>validateAccess(value),error=>!testErrorMessage(error).includes(viewer)&&/Invalid private/.test(testErrorMessage(error)));
 const root=await mkdtemp(join(tmpdir(),'werk-access-files-'));
 try{const path=join(root,'access.json');assert.deepEqual(await loadAccessFile(path,true),{schemaVersion:1,principals:[]});await assert.rejects(loadAccessFile(path));await createPrivate(path,access);assert.equal((await loadAccessFile(path)).principals.length,2);
  if(process.platform!=='win32'){await chmod(path,0o644);await assert.rejects(loadAccessFile(path),/Invalid private/);await chmod(path,0o600);await symlink(path,join(root,'link'));await assert.rejects(loadAccessFile(join(root,'link'),true),/Invalid private/)}
 }finally{await rm(root,{recursive:true,force:true})}
});
test('Factory viewer reads and operator mutations are authorized and audited without sensitive payloads',async()=>{
 const root=await mkdtemp(join(tmpdir(),'werk-factory-access-')),events=[];let app;
 try{app=await startFactoryServer({db:join(root,'registry.sqlite'),host:'127.0.0.1',port:0,adminToken:admin,access,audit:entry=>events.push(entry)});
  const read=await api(app,'/v1/factories',viewer);assert.equal(read.status,200);assert.equal((await read.json()).access.permissions.write,false);
  for(const path of ['/v1/monitoring','/metrics','/v1/access'])assert.equal((await api(app,path,viewer)).status,200);
  assert.equal((await api(app,'/metrics?secret=not-for-logs',viewer)).status,400);
  assert.equal((await api(app,'/v1/factories',viewer,'POST',{id:'root',name:'secret-payload-not-for-logs'})).status,403);
  assert.equal((await api(app,'/v1/factories?secret=not-for-logs',operator,'POST',{id:'root',name:'secret-payload-not-for-logs'})).status,201);
  assert.equal((await api(app,'/v1/factories/root',operator,'PATCH',{name:'Updated'})).status,200);
  assert.equal((await api(app,'/v1/factories/root',viewer,'DELETE')).status,403);
  assert.equal((await api(app,'/v1/factories/root',admin,'DELETE')).status,200);
  await new Promise(ok=>setImmediate(ok));assert.equal(events.length,5);
  assert.ok(events.some(e=>e.actor==='observer'&&e.role==='viewer'&&e.outcome==='denied'&&e.status===403));
  assert.ok(events.some(e=>e.actor==='maintainer'&&e.outcome==='succeeded'&&e.action==='PATCH /v1/factories/:id'));
  const serialized=JSON.stringify(events);for(const secret of [viewer,operator,admin,'not-for-logs','secret-payload'])assert.equal(serialized.includes(secret),false);
  assert.ok(events.every(e=>safeServiceLog({...e,secret:viewer})?.actor===e.actor));assert.equal(JSON.stringify(events.map(e=>safeServiceLog({...e,secret:viewer}))).includes(viewer),false);
 }finally{await app?.close();await rm(root,{recursive:true,force:true})}
});
test('orchestrator viewer cannot submit tasks or enroll using a human token',async()=>{
 const root=await mkdtemp(join(tmpdir(),'werk-line-access-')),events=[];let app;
 try{app=await startServer({db:join(root,'line.sqlite'),host:'127.0.0.1',port:0,project:'demo',adminToken:admin,enrollmentToken:enrollment,access,audit:e=>events.push(e)});
  const overview=await api(app,'/v1/overview',viewer);assert.equal(overview.status,200);assert.equal((await overview.json()).access.principal.id,'observer');
  for(const path of ['/v1/tasks','/v1/workers','/v1/snapshots','/v1/capabilities','/v1/monitoring','/metrics'])assert.equal((await api(app,path,viewer)).status,200);
  assert.equal((await api(app,'/v1/tasks',viewer,'POST',{})).status,403);assert.equal((await api(app,'/v1/iteration/tasks',viewer,'POST',{})).status,403);
  assert.equal((await api(app,'/v1/workers/register',operator,'POST',{})).status,401);
  assert.equal((await api(app,'/v1/tasks',operator,'POST',{})).status,400);
  assert.equal((await api(app,'/v1/access','unknown')).status,401);
  await new Promise(ok=>setImmediate(ok));assert.equal(events.filter(e=>e.outcome==='denied').length,2);
 }finally{await app?.close();await rm(root,{recursive:true,force:true})}
});
test('rotation and rollback require restart and preserve legacy admin authority',async()=>{
 const root=await mkdtemp(join(tmpdir(),'werk-access-rotation-'));let app;
 try{await setup({stateDir:root});const before=await readFile(join(root,'credentials.json'),'utf8');
  await accessCommand('grant',{stateDir:root,id:'reader',role:'viewer'});const first=JSON.parse(await readFile(join(root,'access.json'),'utf8')).principals[0].token;
  const config={db:join(root,'orchestrator.sqlite'),host:'127.0.0.1',port:0,project:'demo',adminToken:admin,enrollmentToken:enrollment,accessFile:join(root,'access.json')};app=await startServer(config);
  assert.equal((await api(app,'/v1/access',first)).status,200);
  const output=[];assert.equal(await main(['access','rotate','--state-dir',root,'--id','reader','--json'],{stdout:s=>output.push(s)}),0);
  const second=JSON.parse(await readFile(join(root,'access.json'),'utf8')).principals[0].token;assert.notEqual(first,second);assert.equal(output.join('').includes(second),false);assert.equal(JSON.parse(output[0]).restartRequired,true);
  assert.equal((await api(app,'/v1/access',first)).status,200);assert.equal((await api(app,'/v1/access',second)).status,401);
  await app.close();app=await startServer(config);assert.equal((await api(app,'/v1/access',first)).status,401);assert.equal((await api(app,'/v1/access',second)).status,200);assert.equal((await api(app,'/v1/access',admin)).status,200);
  await app.close();app=undefined;await accessCommand('rollback',{stateDir:root});app=await startServer(config);assert.equal((await api(app,'/v1/access',first)).status,200);assert.equal((await api(app,'/v1/access',second)).status,401);
  assert.equal(await readFile(join(root,'credentials.json'),'utf8'),before);await assert.rejects(accessCommand('rotate',{stateDir:root,id:'absent'}),/Unknown principal/);
 }finally{await app?.close();await rm(root,{recursive:true,force:true})}
});
test('Docker access wiring tolerates absence but refuses malformed or symbolic-link state',async()=>{
 const root=await mkdtemp(join(tmpdir(),'werk-docker-access-'));const env={WERK_ACCESS_FILE:'inherited-secret-path'};
 try{const path=join(root,'access.json');await configureAccessFile(env,path);assert.equal(env.WERK_ACCESS_FILE,undefined);await createPrivate(path,access);await configureAccessFile(env,path);assert.equal(env.WERK_ACCESS_FILE,path);
  await rm(path);await mkdir(path);await assert.rejects(configureAccessFile(env,path),/Invalid private/);await rm(path,{recursive:true});
  if(process.platform!=='win32'){await symlink(join(root,'absent'),path);await assert.rejects(configureAccessFile(env,path),/Invalid private/)}
 }finally{await rm(root,{recursive:true,force:true})}
});
test('Caddy ingress targets loopback and excludes worker enrollment/status transports',()=>{
 const profile=ingressProfile({hostname:'werk.example.com',port:3100});assert.match(profile,/reverse_proxy 127\.0\.0\.1:3100/);assert.match(profile,/\/v1\/worker\/\* \/v1\/workers\/register \/healthz \/status \/metrics/);assert.match(profile,/respond @private 404/);assert.match(profile,/Strict-Transport-Security/);
 for(const hostname of ['localhost','https://werk.example.com','werk.example.com\n evil','*.example.com'])assert.throws(()=>ingressProfile({hostname,port:3100}));
 assert.throws(()=>ingressProfile({hostname:'werk.example.com',port:80}));
});
