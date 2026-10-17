import { testListeningAddress } from '../../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../../../src/orchestrator/dist/orchestrator/server.js';
import { startFactoryServer } from '../../../src/factory/dist/factory/server.js';
const token='mcp-admin-'.repeat(5), enrollment='mcp-enroll-'.repeat(5);

function client(role,url,writes=false) {
  const child=spawn(process.execPath,[`src/${role}/dist/${role}/cli.js`,'mcp','serve','--url',url,...(writes?['--allow-writes','true']:[])],{env:{...process.env,WERK_ADMIN_TOKEN:token,WERK_FACTORY_ADMIN_TOKEN:token},stdio:['pipe','pipe','pipe']});
  const awaiting=new Map();let next=1,stderr='',stdout='';
  child.stderr.on('data',data=>stderr+=data);child.stdout.on('data',data=>stdout+=data);
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{const value=JSON.parse(line);const pending=awaiting.get(value.id);if(pending){clearTimeout(pending.timeout);awaiting.delete(value.id);pending.resolve(value);}});
  const send=message=>child.stdin.write(JSON.stringify(message)+'\n');
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=next++;const timeout=setTimeout(()=>reject(Error('MCP timeout: '+method)),10000);awaiting.set(id,{resolve,reject,timeout});send({jsonrpc:'2.0',id,method,params});});
  return {child,call,send,get stdout(){return stdout;},get stderr(){return stderr;},async init(version='2025-06-18'){const value=await call('initialize',{protocolVersion:version,capabilities:{},clientInfo:{name:'werk-test',version:'1'}});send({jsonrpc:'2.0',method:'notifications/initialized'});return value;},async close(){child.stdin.end();await once(child,'close');lines.close();for(const value of awaiting.values())clearTimeout(value.timeout);}};
}
const toolData=response=>JSON.parse(response.result.content[0].text);

test('MCP stdio negotiates legacy version and enforces a read-only catalog', {timeout:15000},async()=>{
  const app=await startServer({db:':memory:',host:'127.0.0.1',port:0,adminToken:token,enrollmentToken:enrollment,project:'demo'});
  const session=client('orchestrator','http://127.0.0.1:'+testListeningAddress(app.server).port);
  try{
    assert.equal((await session.call('tools/list')).error.code,-32002);
    assert.equal((await session.init('2024-11-05')).result.protocolVersion,'2024-11-05');
    assert.deepEqual((await session.call('ping')).result,{});
    assert.equal((await session.call('ping',null)).error.code,-32602);
    assert.equal((await session.call('tools/call',{name:'werk_task_list',arguments:null})).error.code,-32602);
    const tools=(await session.call('tools/list')).result.tools;
    assert.ok(tools.some(tool=>tool.name==='werk_task_list'));assert.ok(tools.every(tool=>tool.annotations.readOnlyHint));
    assert.ok(!tools.some(tool=>tool.name==='werk_task_create'||/heartbeat|complete|abandon/.test(tool.name)));
    assert.equal((await session.call('tools/call',{name:'werk_task_create',arguments:{}})).error.code,-32602);
    assert.equal((await session.call('tools/call',{name:'werk_task_list',arguments:{url:'http://evil.invalid'}})).error.code,-32602);
    assert.deepEqual(toolData(await session.call('tools/call',{name:'werk_task_list',arguments:{}})),{tasks:[],hasMore:false,nextCursor:null});
    const snapshots=await session.call('tools/call',{name:'werk_snapshots_list',arguments:{after:0,order:'asc',limit:1}});assert.equal(snapshots.result.isError,false);
    assert.equal((await session.call('unknown/method')).error.code,-32601);
    assert.ok(!session.stdout.includes(token));assert.ok(!session.stderr.includes(token));
  }finally{await session.close();await app.close();}
});

test('MCP task creation reaches the real orchestrator with reference intake and stable idempotency', {timeout:15000},async()=>{
  const app=await startServer({db:':memory:',host:'127.0.0.1',port:0,adminToken:token,enrollmentToken:enrollment,project:'demo'});
  const session=client('orchestrator','http://127.0.0.1:'+testListeningAddress(app.server).port,true);
  try{
    await session.init();const args={task:{project:'demo',requirementRef:'[[Features/Invoice]]'},idempotencyKey:'mcp-feature-1'};
    const a=toolData(await session.call('tools/call',{name:'werk_task_create',arguments:args}));
    const b=toolData(await session.call('tools/call',{name:'werk_task_create',arguments:args}));
    assert.equal(a.id,b.id);assert.equal(a.requirementRef,'[[Features/Invoice]]');assert.equal(app.store.list().length,1);
    assert.equal((await session.call('tools/call',{name:'werk_task_create',arguments:{task:args.task}})).error.code,-32602);
    const conflict=await session.call('tools/call',{name:'werk_task_create',arguments:{...args,task:{project:'demo',requirementRef:'[[Different]]'}}});
    assert.equal(conflict.result.isError,true);assert.match(conflict.result.content[0].text,/409/);
    assert.equal(toolData(await session.call('tools/call',{name:'werk_task_events',arguments:{id:a.id}})).events.length,1);
  }finally{await session.close();await app.close();}
});

test('MCP Factory tools operate on real hierarchy registry and require explicit write keys', {timeout:15000},async()=>{
  const app=await startFactoryServer({db:':memory:',host:'127.0.0.1',port:0,adminToken:token});
  const session=client('factory','http://127.0.0.1:'+testListeningAddress(app.server).port,true);
  try{
    await session.init();
    const tools=(await session.call('tools/list')).result.tools;
    assert.equal(tools.find(tool=>tool.name==='werk_factory_create').annotations.idempotentHint,true);
    assert.ok(tools.some(tool=>tool.name==='werk_line_update'));
    const created=toolData(await session.call('tools/call',{name:'werk_factory_create',arguments:{factory:{id:'root',name:'Product factory',parentId:null},idempotencyKey:'factory-1'}}));
    assert.equal(created.id,'root');
    const updated=toolData(await session.call('tools/call',{name:'werk_factory_update',arguments:{id:'root',changes:{name:'Portfolio'},idempotencyKey:'factory-2'}}));assert.equal(updated.name,'Portfolio');
    assert.equal(toolData(await session.call('tools/call',{name:'werk_factory_overview',arguments:{factoryId:'root'}})).factories.length,1);
    const deleted=toolData(await session.call('tools/call',{name:'werk_factory_delete',arguments:{id:'root',idempotencyKey:'factory-3'}}));assert.equal(deleted.deleted,true);
  }finally{await session.close();await app.close();}
});

test('MCP errors and successful tool responses redact configured credentials', {timeout:15000},async()=>{
  let fail=false,large=false;
  const server=createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer '+token);res.writeHead(fail?401:200,{'content-type':'application/json'});res.end(JSON.stringify(fail?{error:'secret '+token}:large?{data:'x'.repeat(1100000)}:{token,detail:'token='+token,[token]:'echoed as property'}));});
  await new Promise(resolve=>server.listen(0, '127.0.0.1', () => resolve(undefined)));const session=client('orchestrator','http://127.0.0.1:'+testListeningAddress(server).port);
  try{
    await session.init();const value=toolData(await session.call('tools/call',{name:'werk_orchestrator_overview',arguments:{}}));
    assert.equal(value.token,'[REDACTED]');assert.ok(!JSON.stringify(value).includes(token));
    fail=true;const error=await session.call('tools/call',{name:'werk_orchestrator_overview',arguments:{}});assert.equal(error.result.isError,true);assert.ok(!JSON.stringify(error).includes(token));
    assert.ok(!session.stdout.includes(token));assert.ok(!session.stderr.includes(token));
    fail=false;large=true;const capped=await session.call('tools/call',{name:'werk_orchestrator_overview',arguments:{}});assert.equal(capped.error.code,-32000);assert.match(capped.error.message,/1 MiB/);
  }finally{await session.close();await new Promise(resolve=>server.close(resolve));}
});

test('MCP malformed JSON and input caps produce protocol errors without non-JSON stdout', {timeout:15000},async()=>{
  const child=spawn(process.execPath,['src/orchestrator/dist/orchestrator/cli.js','mcp','serve'],{env:{...process.env,WERK_ADMIN_TOKEN:token},stdio:['pipe','pipe','pipe']});
  let output='',stderr='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>stderr+=x);
  child.stdin.end('{bad json}\n'+JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})+'\n'+'x'.repeat(66000)+'\n');await once(child,'close');
  const messages=output.trim().split('\n').map(line=>JSON.parse(line));assert.equal(messages[0].error.code,-32700);assert.deepEqual(messages[1].result,{});assert.match(messages[2].error.message,/64 KiB/);assert.ok(!stderr.includes(token));
});

test('MCP invalid startup options use the documented input-error exit status',async()=>{
  const child=spawn(process.execPath,['src/orchestrator/dist/orchestrator/cli.js','mcp','serve','--allow-writes','yes'],{env:{...process.env,WERK_ADMIN_TOKEN:token},stdio:['ignore','pipe','pipe']});
  let output='',stderr='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>stderr+=x);
  const [code]=await once(child,'close');assert.equal(code,2);assert.equal(output,'');assert.ok(!stderr.includes(token));
});


test('Factory MCP receipts replay all mutation results after restart without resurrecting deleted resources', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-factory-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { db: join(directory, 'factory.sqlite'), host: '127.0.0.1', port: 0, adminToken: token };
  const createFactory = { factory: { id: 'root', name: 'Original factory', parentId: null }, idempotencyKey: 'root-create' };
  const mutations = [
    ['werk_factory_create', createFactory],
    ['werk_line_create', { line: { id: 'line', name: 'Original line', factoryId: 'root', orchestratorUrl: 'http://127.0.0.1:1', webviewUrl: 'http://127.0.0.1:1', tokenEnv: 'WERK_LINE_DEMO_TOKEN' }, idempotencyKey: 'line-create' }],
    ['werk_line_update', { id: 'line', changes: { name: 'Changed line' }, idempotencyKey: 'line-update' }],
    ['werk_line_delete', { id: 'line', idempotencyKey: 'line-delete' }],
    ['werk_factory_update', { id: 'root', changes: { name: 'Changed factory' }, idempotencyKey: 'root-update' }],
    ['werk_factory_delete', { id: 'root', idempotencyKey: 'root-delete' }],
  ];
  const original = [];
  for (const restarting of [false, true]) {
    // Successful replay remains valid after credentials are removed from deployment configuration.
    const app = await startFactoryServer({ ...config, credentials: restarting ? {} : { WERK_LINE_DEMO_TOKEN: 'private-production-line-token' } });
    const session = client('factory', 'http://127.0.0.1:' + testListeningAddress(app.server).port, true);
    try {
      await session.init();
      const tools = (await session.call('tools/list')).result.tools;
      for (const [index, [name, args]] of mutations.entries()) {
        const definition = tools.find(tool => tool.name === name);
        assert.equal(definition.annotations.idempotentHint, true); assert.match(definition.description, /registry database.*across restarts/);
        const response = await session.call('tools/call', { name, arguments: args });
        assert.equal(response.result.isError, false, JSON.stringify(response));
        if (restarting) assert.deepEqual(toolData(response), original[index]); else original.push(toolData(response));
      }
      assert.deepEqual(toolData(await session.call('tools/call', { name: 'werk_factory_list', arguments: {} })), { factories: [], access: { principal: { id: 'legacy-admin', role: 'admin' }, permissions: { read: true, write: true } } });
      assert.deepEqual(toolData(await session.call('tools/call', { name: 'werk_line_list', arguments: {} })), { lines: [] });
      const conflict = await session.call('tools/call', { name: 'werk_factory_create', arguments: { ...createFactory, factory: { ...createFactory.factory, name: 'Conflicting intent' } } });
      assert.equal(conflict.result.isError, true); assert.match(conflict.result.content[0].text, /HTTP 409/);
      assert.ok(!session.stdout.includes(token)); assert.ok(!session.stdout.includes('private-production-line-token')); assert.equal(session.stderr, '');
    } finally { await session.close(); await app.close(); }
  }
});
