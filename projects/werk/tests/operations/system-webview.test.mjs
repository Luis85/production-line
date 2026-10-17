import { testListeningAddress } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/orchestrator/dist/orchestrator/server.js';
import { startFactoryServer } from '../../src/factory/dist/factory/server.js';
import { validateDefinition } from '../../scripts/system/definition.mjs';
import { bootstrapSystem } from '../../scripts/system/bootstrap.mjs';
test('system public browser links preserve private API bootstrap and registry drift protection', async () => {
  const root=await mkdtemp(join(tmpdir(),'werk-public-origin-'));let line,factory;
  const adminToken='a'.repeat(64),lineToken='b'.repeat(64),credentials={WERK_LINE_SYSTEM_1_TOKEN:lineToken};
  try {
    line=await startServer({db:join(root,'line.sqlite'),host:'127.0.0.1',port:0,project:'demo',adminToken:lineToken,enrollmentToken:'c'.repeat(64)});
    factory=await startFactoryServer({db:join(root,'factory.sqlite'),host:'127.0.0.1',port:0,adminToken,credentials});
    const linePort=testListeningAddress(line.server).port,factoryPort=testListeningAddress(factory.server).port;
    const value=validateDefinition({schemaVersion:1,id:'demo',environment:'native',factory:{id:'root',name:'Root',port:factoryPort},productionLines:[{id:'alpha',name:'Alpha',project:'demo',orchestrator:{port:linePort,webviewUrl:'https://unreachable.invalid'},workers:{count:1,statusPort:[62000,62001,62002].find(port=>![linePort,factoryPort].includes(port))}}]});
    await bootstrapSystem(value,{adminToken,credentials});
    const row=factory.registry.lines()[0];assert.equal(row.webviewUrl,'https://unreachable.invalid/');assert.equal(row.orchestratorUrl,`http://127.0.0.1:${linePort}`);
    await bootstrapSystem(value,{adminToken,credentials});
    const changed=structuredClone(value);changed.productionLines[0].orchestrator.webviewUrl='https://different.invalid/';
    await assert.rejects(bootstrapSystem(changed,{adminToken,credentials}),/registry differs/);
    assert.deepEqual(factory.registry.lines()[0],row);
  } finally {await line?.close();await factory?.close();await rm(root,{recursive:true,force:true});}
});
