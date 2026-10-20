import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { modelFor } from '../../src/worker/dist/worker/infrastructure/providers.js';
import { prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';
import { processRuntimePreparing } from '../../src/worker/dist/shared/process/launcher.js';

const execute = promisify(execFile);
const skip = process.platform !== 'win32' && 'Native Windows provider setup and invocation ordering';

test('direct cold CLI models prepare before authentication or billable admission, and cancellation never becomes authentication failure', {skip, timeout:90000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-provider-prepare-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const marker = join(directory, 'calls.txt'), source = join(directory, 'provider.cs'), executable = join(directory, 'provider.exe');
  // An executable protocol fixture, never a real provider login or billable invocation.
  await writeFile(source, `using System;using System.IO;public class Fixture {public static int Main(string[] args) {File.AppendAllText(${JSON.stringify(marker)},String.Join(" ",args)+"\\n");Console.Write(args.Length>0&&args[0]=="auth"?"{\\"loggedIn\\":true,\\"authMethod\\":\\"claude.ai\\"}":"{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"fixture completed\\"}");return 0;}}`);
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await execute(powershell, ['-NoLogo','-NoProfile','-NonInteractive','-Command','$ErrorActionPreference="Stop"; Add-Type -Path $env:WERK_TEST_SOURCE -OutputAssembly $env:WERK_TEST_EXE -OutputType ConsoleApplication'], {env:{...process.env,WERK_TEST_SOURCE:source,WERK_TEST_EXE:executable},timeout:20000,windowsHide:true});
  const providersUrl = new URL('../../src/worker/dist/worker/infrastructure/providers.js', import.meta.url).href;
  const contractsUrl = new URL('../../src/worker/dist/worker/application/model-contract.js', import.meta.url).href;
  const launcherUrl = new URL('../../src/worker/dist/shared/process/launcher.js', import.meta.url).href;
  const connection = {id:/** @type {const} */('claude-cli'),executable,model:'',apiKey:'',authenticationMode:/** @type {const} */('cli-account')};
  const childScript = `import {modelFor} from ${JSON.stringify(providersUrl)};import {prepareModelRequest} from ${JSON.stringify(contractsUrl)};import {processRuntimePreparing} from ${JSON.stringify(launcherUrl)};const cancel=process.argv[1]==='cancel';const connection=${JSON.stringify(connection)};if(!cancel){connection.authenticationMode='api-key';connection.apiKey='fixture-only-key';}const model=modelFor(connection,${JSON.stringify(directory)});let calls=0;try{const result=await model.execute(prepareModelRequest(model,[]),AbortSignal.timeout(cancel?1:60000),undefined,{beforeCall(){if(processRuntimePreparing())throw Error('Provider admitted while runtime was preparing');calls++;}});console.log(JSON.stringify({calls,result}));}catch(error){console.log(JSON.stringify({calls,code:error.code}));}`;
  const cancelled = await execute(process.execPath, ['--input-type=module','-e',childScript,'cancel'], {timeout:15000,windowsHide:true,maxBuffer:65536});
  assert.deepEqual(JSON.parse(cancelled.stdout), {calls:0,code:'cancelled'});
  await assert.rejects(readFile(marker), {code:'ENOENT'});
  const model = modelFor(connection, directory); assert.ok(model);
  let calls = 0;
  const result = await model.execute(prepareModelRequest(model, []), t.signal, undefined, {beforeCall() { assert.equal(processRuntimePreparing(), false); calls++; }});
  assert.deepEqual(result, {type:'completed',text:'fixture completed'}); assert.equal(calls, 1);
  const apiKey = await execute(process.execPath, ['--input-type=module','-e',childScript,'api-key'], {timeout:60000,windowsHide:true,maxBuffer:65536});
  assert.deepEqual(JSON.parse(apiKey.stdout), {calls:1,result:{type:'completed',text:'fixture completed'}});
  const invocations = (await readFile(marker,'utf8')).trim().split('\n');
  assert.equal(invocations.filter(line => line === 'auth status').length, 1, 'only selected account billing requires the authentication probe');
  assert.equal(invocations.filter(line => line.startsWith('--print ')).length, 2, 'each admitted model invocation runs exactly once after setup');
});


test('a cold API model prepares command tools before its first request while preserving a one-second command limit', {skip, timeout:60000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'werk-api-tool-prepare-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const paths = {
    providers: new URL('../../src/worker/dist/worker/infrastructure/providers.js', import.meta.url).href,
    contracts: new URL('../../src/worker/dist/worker/application/model-contract.js', import.meta.url).href,
    runtime: new URL('../../src/worker/dist/worker/infrastructure/tool-runtime.js', import.meta.url).href,
    policy: new URL('../../src/worker/dist/worker/application/tool-policy.js', import.meta.url).href,
    launcher: new URL('../../src/worker/dist/shared/process/launcher.js', import.meta.url).href,
  };
  const script = `import assert from 'node:assert/strict';import {modelFor} from ${JSON.stringify(paths.providers)};import {prepareModelRequest} from ${JSON.stringify(paths.contracts)};import {createToolRuntime} from ${JSON.stringify(paths.runtime)};import {defaultToolPolicy} from ${JSON.stringify(paths.policy)};import {processRuntimePreparing} from ${JSON.stringify(paths.launcher)};
const policy=defaultToolPolicy();policy.builtins.commands=[{id:'quick',name:'Quick',executable:process.execPath,args:['-e','console.log("tool complete")'],enabled:true}];
const factory=()=>createToolRuntime({policy,currentRevision:()=>policy.revision,directory:${JSON.stringify(directory)},maxRuntimeMs:60000,commandTimeoutMs:1000});let requests=0;const model=modelFor({id:'openai-api',model:'fixture',apiKey:'fixture-only',executable:''},${JSON.stringify(directory)},async(_url,options)=>{assert.equal(processRuntimePreparing(),false);requests++;if(requests===1)return Response.json({status:'completed',output:[{type:'function_call',name:'werk_command_run',call_id:'one',arguments:'{"preset":"quick"}'}]});assert.match(options.body,/tool complete/);return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'complete'}]}]});},{tools:factory});Object.defineProperty(model,'executionPolicy',{value:{maxRuntimeMs:60000,commandTimeoutMs:1000}});const request=prepareModelRequest(model,[]);assert.equal(processRuntimePreparing(),false,'metadata inspection starts no preparation');assert.equal(request.policy.commandTimeoutMs,1000);const result=await model.execute(request,AbortSignal.timeout(60000));console.log(JSON.stringify({requests,result}));`;
  const result = await execute(process.execPath, ['--input-type=module','-e',script], {timeout:60000,windowsHide:true,maxBuffer:65536});
  assert.deepEqual(JSON.parse(result.stdout), {requests:2,result:{type:'completed',text:'complete'}});
});
