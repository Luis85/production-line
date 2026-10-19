import { requiredValue } from '../ui/helpers/required-value.mjs';
import { testErrorCode, testListeningAddress } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { channel } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { WorkerConversation } from '../../src/worker/dist/worker/application/conversation.js';
import { defaultExecutionPolicy, validateExecutionPolicy } from '../../src/worker/dist/worker/application/execution-policy.js';
import { prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { providerTransport } from '../../src/worker/dist/worker/infrastructure/provider-transport.js';
test('execution policy bounds are explicit and saved request budget is immutable', () => {
  const candidate = { candidateSourceMaxBytes: 67108864, candidateSourceMaxFiles: 20000, candidateFileMaxBytes: 8388608, candidateApprovedFileMaxBytes: 24000, candidateApprovedTotalMaxBytes: 48000, candidateReviewPatchMaxBytes: 120000 };
  assert.deepEqual(defaultExecutionPolicy(), { maxRuntimeMs: 21600000, maxToolCalls: 128, commandTimeoutMs: 300000, ...candidate });
  assert.deepEqual(validateExecutionPolicy({ maxRuntimeMs: 1000 }), { maxRuntimeMs: 1000, maxToolCalls: 128, commandTimeoutMs: 300000, ...candidate }, 'old saved policies adopt bounded tool defaults');
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
  let budget = 30;
  const seen = /** @type {{ value?: AbortSignal }} */ ({});
  const store = {async read(){return {messages:[]}},async write(){}};
  const model = {async reply(_messages,signal){seen.value=signal; await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true})); signal.throwIfAborted(); return '';}};
  const conversation = new WorkerConversation(store,model,()=>budget);
  await conversation.init(); await conversation.start('fixture'); budget=86400000;
  await new Promise(resolve=>setTimeout(resolve,70));
  assert.equal(requiredValue(seen.value).aborted,true); assert.equal(conversation.snapshot().messages.at(-1).state,'error');
  assert.match(conversation.snapshot().messages.at(-1).text,/configured execution time limit/);
  await conversation.close();
});
test('provider transport accepts delayed headers/body and aborts cleanly without retries', { timeout: 7000 }, async () => {
  // Advance the pinned transport's test clock, not the invocation's real deadline.
  // Request diagnostics omit deadlines inherited from the owned Agent.
  const providerRequire = createRequire(new URL('../../src/worker/dist/worker/infrastructure/provider-transport.js', import.meta.url));
  const transportTimers = providerRequire('undici/lib/util/timers.js');
  let calls = 0, dispatched = 0, firstStarted, secondStarted, receivedHeaders;
  const firstAdmission = new Promise(resolve => { firstStarted = resolve; });
  const secondAdmission = new Promise(resolve => { secondStarted = resolve; });
  const headers = new Promise(resolve => { receivedHeaders = resolve; });
  const server = createServer((request, response) => {
    request.resume(); calls++;
    if (calls === 1) firstStarted(response); else secondStarted(response);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = 'http://127.0.0.1:' + testListeningAddress(server).port;
  const requests = channel('undici:request:create'), responses = channel('undici:request:headers');
  const observeRequest = ({ request }) => { if (request.origin === url) dispatched++; };
  const observeHeaders = ({ request }) => { if (request.origin === url) receivedHeaders(); };
  requests.subscribe(observeRequest); responses.subscribe(observeHeaders);
  try {
    let settled = false;
    const first = providerTransport(url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) });
    first.then(() => { settled = true; }, () => { settled = true; });
    const waitFor = (barrier, pending) => Promise.race([barrier, pending.then(() => { throw Error('Provider settled before the test barrier'); })]);
    const response = await waitFor(firstAdmission, first);
    const advancePastDefault = async () => { transportTimers.tick(1); transportTimers.tick(301000); await nextTurn(); await nextTurn(); };
    await advancePastDefault();
    assert.equal(settled, false, 'the default five-minute header cap must not end an admitted invocation');
    response.writeHead(200, { 'content-type': 'application/json' }); response.write('{');
    await waitFor(headers, first);
    await advancePastDefault();
    assert.equal(settled, false, 'the default five-minute body cap must not end an admitted invocation');
    response.end('"ok":true}');
    assert.deepEqual(await (await first).json(), { ok: true });
    const controller = new AbortController();
    const cancelled = assert.rejects(providerTransport(url, { method: 'POST', body: '{}', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) }), error => error instanceof Error && (error.name === 'AbortError' || testErrorCode(error) === 'cancelled'));
    await Promise.race([secondAdmission, cancelled]); controller.abort(); await cancelled;
    assert.equal(calls, 2); assert.equal(dispatched, 2, 'neither delayed nor cancelled inference is retried');
  } finally {
    requests.unsubscribe(observeRequest); responses.unsubscribe(observeHeaders);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    transportTimers.reset();
  }
});

test('provider transport honors opt-in environment proxy without mutating global dispatcher', async () => {
  let tunnels=0;
  const proxy=createServer((request,response)=>{tunnels++;request.resume();response.writeHead(200,{'content-type':'application/json'});response.end('{"ok":true}');});
  proxy.on('connect',(_request,socket)=>{tunnels++;socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.once('data',()=>socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"ok":true}'));});
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  const keys=['NODE_USE_ENV_PROXY','http_proxy','HTTP_PROXY','https_proxy','HTTPS_PROXY','no_proxy','NO_PROXY'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try {
    process.env.NODE_USE_ENV_PROXY='1';process.env.http_proxy='http://127.0.0.1:'+testListeningAddress(proxy).port;process.env.HTTP_PROXY=process.env.http_proxy;
    process.env.no_proxy='';process.env.NO_PROXY='';
    const result=await providerTransport('http://werk-fixture.invalid/',{method:'POST',body:'{}',signal:AbortSignal.timeout(1000)});
    assert.deepEqual(await result.json(),{ok:true});assert.equal(tunnels,1);
  } finally {for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
});
