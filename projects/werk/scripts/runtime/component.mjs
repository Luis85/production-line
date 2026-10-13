import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { unlink, readdir } from 'node:fs/promises';
import { assertNode, privateDirectory, readPrivate, createPrivate, inputError } from './config.mjs';

/** Start exactly one independent service. State and credentials survive every restart. */
export async function runComponent(kind, argv) {
  assertNode();
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--help') { console.log(`node werk.mjs ${kind} run [--state-dir PATH] [--host 127.0.0.1] [--port ${kind === 'factory' ? '3100' : '3000'}]${kind === 'orchestrator' ? ' [--project demo]' : ''}`); return; }
    if (!['--state-dir', '--host', '--port', ...(kind === 'orchestrator' ? ['--project'] : [])].includes(key) || options[key] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) throw inputError('Unknown, repeated or incomplete component option. Use --help.');
    options[key] = argv[++index];
  }
  const state = resolve(options['--state-dir'] ?? '.werk/' + kind), host = options['--host'] ?? '127.0.0.1';
  const port = Number(options['--port'] ?? (kind === 'factory' ? 3100 : 3000));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw inputError('port: integer 1–65535');
  await privateDirectory(state);
  const runId = randomUUID(), lock = join(state, 'runtime.lock');
  try { await createPrivate(lock, { runId, pid: process.pid, kind }); }
  catch (error) { if (error.code === 'EEXIST') throw inputError('This state directory is locked. Stop its component first; after a crash verify the old process has exited before removing runtime.lock.'); throw error; }
  let service, closing;
  const stop = () => closing ??= (async () => { try { await service?.close(); } finally { const owner = await readPrivate(lock); if (owner.runId === runId) await unlink(lock); } })();
  try {
    const path = join(state, 'component.json'); let config;
    const entries = await readdir(state);
    if (entries.some(name => ['config.json', 'credentials.json', 'setup.lock', 'supervisor.json', 'worker.lock', 'docker-volume.json'].includes(name))) throw inputError('This directory belongs to a managed runtime or worker. Use a separate empty component state directory.');
    try { config = await readPrivate(path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (entries.some(name => name !== 'runtime.lock')) throw inputError('State exists without component.json. Restore it from backup or use an empty state directory.');
      const project = options['--project'] ?? 'demo';
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(project)) throw inputError('Invalid project identifier');
      config = { schemaVersion: 1, kind, project, adminToken: randomBytes(32).toString('hex'), enrollmentToken: randomBytes(32).toString('hex') };
      await createPrivate(path, config);
    }
    if (config.schemaVersion !== 1 || config.kind !== kind || !/^[A-Za-z0-9_-]{1,100}$/.test(config.project) || !/^[a-f0-9]{64}$/.test(config.adminToken) || !/^[a-f0-9]{64}$/.test(config.enrollmentToken) || config.adminToken === config.enrollmentToken) throw inputError('Invalid component state. Restore component.json from a trusted backup.');
    if (options['--project'] && options['--project'] !== config.project) throw inputError('This state directory belongs to another project. Use a separate state directory.');
    if (kind === 'orchestrator') {
      const { startServer } = await import('../../src/orchestrator/dist/orchestrator/server.js');
      service = await startServer({ db: join(state, 'orchestrator.sqlite'), host, port, project: config.project, adminToken: config.adminToken, enrollmentToken: config.enrollmentToken });
    } else {
      const { startFactoryServer } = await import('../../src/factory/dist/factory/server.js');
      service = await startFactoryServer({ db: join(state, 'factory.sqlite'), host, port, adminToken: config.adminToken });
    }
    console.log(JSON.stringify({ service: kind, url: `http://${host.includes(':') ? '[' + host + ']' : host}:${port}`, stateDirectory: state, credentialsFile: path }));
    const finish = () => { void stop().catch(() => { console.error('Component shutdown failed. Inspect its state before restarting.'); process.exitCode = 1; }); };
    process.once('SIGINT', finish); process.once('SIGTERM', finish);
  } catch (error) { await stop(); throw error; }
}
