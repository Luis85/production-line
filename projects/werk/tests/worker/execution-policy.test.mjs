import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { channel } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { WorkerConversation } from '../../src/worker/dist/worker/application/conversation.js';
import { defaultExecutionPolicy, validateExecutionPolicy } from '../../src/worker/dist/worker/application/execution-policy.js';
import { prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { providerTransport } from '../../src/worker/dist/worker/infrastructure/provider-transport.js';
test('execution policy bounds are explicit and saved request budget is immutable', () => {
  assert.deepEqual(defaultExecutionPolicy(), { maxRuntimeMs: 21600000, maxToolCalls: 128, commandTimeoutMs: 300000 });
  assert.deepEqual(validateExecutionPolicy({ maxRuntimeMs: 1000 }), { maxRuntimeMs: 1000, maxToolCalls: 128, commandTimeoutMs: 300000 }, 'old saved policies adopt bounded tool defaults');
  for (const maxToolCalls of [1, 128, 512]) assert.equal(validateExecutionPolicy({ maxRuntimeMs: 1000, maxToolCalls }).maxToolCalls, maxToolCalls);
  for (const commandTimeoutMs of [1000, 300000, 3600000]) assert.equal(validateExecutionPolicy({ maxRuntimeMs: 1000, commandTimeoutMs }).commandTimeoutMs, commandTimeoutMs);
  for (const maxToolCalls of [0, 513, 1.5, '128', null, NaN]) assert.throws(() => validateExecutionPolicy({ maxRuntimeMs: 1000, maxToolCalls }));
  for (const commandTimeoutMs of [0, 999, 3600001, 1.5, '300000', null, NaN]) assert.throws(() => validateExecutionPolicy({ maxRuntimeMs: 1000, commandTimeoutMs }));
  for (const maxRuntimeMs of [1000, 21600000, 86400000]) assert.equal(validateExecutionPolicy({maxRuntimeMs}).maxRuntimeMs, maxRuntimeMs);
  for (const maxRuntimeMs of [0,999,86400001,1.5,'1000',NaN]) assert.throws(() => validateExecutionPolicy({maxRuntimeMs}));
  const request = prepareModelRequest({reply:async()=>''}, [], 'chat', 86400000);
  assert.equal(request.policy.maxRuntimeMs,86400000); assert.ok(Object.isFrozen(request.policy));
});
test('chat snapshots admission budget and injected short deadline retains timeout guidance', async () => {
  let budget = 30, seen;
  const store = {async read(){return {messages:[]}},async write(){}};
  const model = {async reply(_messages,signal){seen=signal; await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true})); signal.throwIfAborted();}};
  const conversation = new WorkerConversation(store,model,()=>budget);
  await conversation.init(); await conversation.start('fixture'); budget=86400000;
  await new Promise(resolve=>setTimeout(resolve,70));
  assert.equal(seen.aborted,true); assert.equal(conversation.snapshot().messages.at(-1).state,'error');
  assert.match(conversation.snapshot().messages.at(-1).text,/configured execution time limit/);
  await conversation.close();
});
test('provider transport accepts delayed headers/body and aborts cleanly without retries', async () => {
  let calls=0; const observed=[];
  const requests=channel('undici:request:create'); const observe=({request})=>observed.push({headersTimeout:request.headersTimeout,bodyTimeout:request.bodyTimeout}); requests.subscribe(observe);
  const server=createServer((request,response)=>{calls++;request.resume();setTimeout(()=>{response.writeHead(200,{'content-type':'application/json'});response.write('{');setTimeout(()=>response.end('"ok":true}'),30);},30)});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const url='http://127.0.0.1:'+server.address().port;
  try {
    const result=await providerTransport(url,{method:'POST',body:'{}',signal:AbortSignal.timeout(1000)});
    assert.deepEqual(await result.json(),{ok:true});
    await assert.rejects(providerTransport(url,{method:'POST',body:'{}',signal:AbortSignal.timeout(10)}));
    assert.equal(calls,2); assert.equal(observed.length,2);
    for(const request of observed) assert.deepEqual(request,{headersTimeout:0,bodyTimeout:0});
  } finally {requests.unsubscribe(observe);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('provider transport honors opt-in environment proxy without mutating global dispatcher', async () => {
  let tunnels=0;
  const proxy=createServer((request,response)=>{tunnels++;request.resume();response.writeHead(200,{'content-type':'application/json'});response.end('{"ok":true}');});
  proxy.on('connect',(_request,socket)=>{tunnels++;socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.once('data',()=>socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"ok":true}'));});
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  const keys=['NODE_USE_ENV_PROXY','http_proxy','HTTP_PROXY','https_proxy','HTTPS_PROXY','no_proxy','NO_PROXY'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try {
    process.env.NODE_USE_ENV_PROXY='1';process.env.http_proxy='http://127.0.0.1:'+proxy.address().port;process.env.HTTP_PROXY=process.env.http_proxy;
    process.env.no_proxy='';process.env.NO_PROXY='';
    const result=await providerTransport('http://werk-fixture.invalid/',{method:'POST',body:'{}',signal:AbortSignal.timeout(1000)});
    assert.deepEqual(await result.json(),{ok:true});assert.equal(tunnels,1);
  } finally {for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
});
