import { workerDocument } from './execution.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseRoot } from './config.mjs';

// Control messages come only from the direct owning parent IPC channel. Neither secrets nor
// control instructions are put in process arguments, stdout or child diagnostic messages.
let stopRequested = false, server, stopping, role;
const abort = new AbortController();
async function stop() {
  stopRequested = true; abort.abort();
  if (server) { stopping ??= server.close(); await stopping; if (process.connected) process.disconnect(); }
}
process.on('disconnect', () => void stop());
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
let initialized = false;
process.on('message', async message => {
  if (message?.command === 'stop') { await stop(); return; }
  if (message?.command !== 'start' || initialized) return;
  initialized = true;
  try {
    if (stopRequested) throw Error('Startup cancelled');
    const { config, stateDir, credentials, index } = message; role = message.role;
    const load = file => import(pathToFileURL(join(releaseRoot, file)).href);
    if (role === 'orchestrator') {
      const { startServer } = await load('src/orchestrator/dist/orchestrator/server.js');
      const { loadAccessFile } = await load('src/orchestrator/dist/shared/http/access.js');
      server = await startServer({ db: join(stateDir, 'orchestrator.sqlite'), host: '127.0.0.1', port: config.orchestratorPort, project: config.project,
        access: await loadAccessFile(join(stateDir, 'access.json'), true), adminToken: credentials.WERK_ADMIN_TOKEN, enrollmentToken: credentials.WERK_ENROLLMENT_TOKEN });
      if (stopRequested) await stop();
      else process.send?.({ event: 'listening', role });
      if (stopping) await stopping;
    } else if (role === 'worker') {
      const { runWorker } = await load('src/worker/dist/worker/runner.js');
      const { configuration } = await load('src/worker/dist/worker/config.js');
      const effective = await configuration({}, workerDocument(config.execution, config.chat));
      await runWorker({ ...effective, url: `http://127.0.0.1:${config.orchestratorPort}`, stateDir: join(stateDir, 'workers', `worker-${index}`),
        enrollmentToken: credentials.WERK_ENROLLMENT_TOKEN, statusHost: '127.0.0.1', statusPort: config.workerPort + index - 1 }, abort.signal);
      if (process.connected) process.disconnect();
    } else throw Error('Unknown runtime role');
  } catch {
    process.send?.({ event: 'failed' }); process.exitCode = 1;
    await stop().catch(() => {}); if (process.connected) process.disconnect();
  }
});
