import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { unlink, readdir, rename } from 'node:fs/promises';
import { assertNode, privateDirectory, readPrivate, createPrivate, inputError } from './config.mjs';
import { loadEnvironment, environmentDefaults } from './portable/environment.mjs';

/** Start exactly one independent service. State and credentials survive every restart. */
export async function runComponent(kind, argv, lifecycle = {}) {
  assertNode();
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--help') { console.log(`node werk.mjs ${kind} run [--state-dir PATH] [--host 127.0.0.1] [--port ${kind === 'factory' ? '3100' : '3000'}]${kind === 'orchestrator' ? ' [--project demo]' : ''}`); return; }
    if (!['--state-dir', '--host', '--port', '--project-dir', ...(kind === 'orchestrator' ? ['--project'] : [])].includes(key) || options[key] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) throw inputError('Unknown, repeated or incomplete component option. Use --help.');
    options[key] = argv[++index];
  }
  if (!lifecycle.environmentLoaded) {
    const directory = resolve(options['--project-dir'] ?? process.cwd());
    await loadEnvironment(kind, directory);
    for (const [key, value] of Object.entries(environmentDefaults(kind, process.env, directory))) options['--' + key] ??= value;
    options['--state-dir'] ??= join(directory, '.werk', kind);
  }
  const adminToken = process.env[kind === 'factory' ? 'WERK_FACTORY_ADMIN_TOKEN' : 'WERK_ADMIN_TOKEN'];
  const enrollmentToken = kind === 'orchestrator' ? process.env.WERK_ENROLLMENT_TOKEN : undefined;
  for (const value of [adminToken, enrollmentToken]) if (value !== undefined && !/^[a-f0-9]{64}$/.test(value)) throw inputError('Component environment tokens must contain exactly 64 lowercase hexadecimal characters.');
  if (adminToken !== undefined && adminToken === enrollmentToken) throw inputError('Component admin and enrollment tokens must be distinct.');
  const state = resolve(options['--state-dir'] ?? '.werk/' + kind), host = options['--host'] ?? '127.0.0.1';
  const port = Number(options['--port'] ?? (kind === 'factory' ? 3100 : 3000));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw inputError('port: integer 0–65535');
  await privateDirectory(state);
  const runId = randomUUID(), lock = join(state, 'runtime.lock');
  const { processHost } = await import(new URL(`../../src/${kind}/dist/shared/process/owner.js`, import.meta.url));
  try { await createPrivate(lock, { runId, pid: process.pid, host: processHost, kind }); }
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
      if (entries.some(name => !['runtime.lock', 'portable.log'].includes(name))) throw inputError('State exists without component.json. Restore it from backup or use an empty state directory.');
      const project = options['--project'] ?? 'demo';
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(project)) throw inputError('Invalid project identifier');
      config = { schemaVersion: 1, kind, project, adminToken: adminToken ?? randomBytes(32).toString('hex'), enrollmentToken: enrollmentToken ?? randomBytes(32).toString('hex') };
      await createPrivate(path, config);
    }
    if (config.schemaVersion !== 1 || config.kind !== kind || !/^[A-Za-z0-9_-]{1,100}$/.test(config.project) || !/^[a-f0-9]{64}$/.test(config.adminToken) || !/^[a-f0-9]{64}$/.test(config.enrollmentToken) || config.adminToken === config.enrollmentToken) throw inputError('Invalid component state. Restore component.json from a trusted backup.');
    if (options['--project'] && options['--project'] !== config.project) throw inputError('This state directory belongs to another project. Use a separate state directory.');
    const selected = { ...config, adminToken: adminToken ?? config.adminToken, enrollmentToken: enrollmentToken ?? config.enrollmentToken };
    if (selected.adminToken === selected.enrollmentToken) throw inputError('Component admin and enrollment tokens must be distinct.');
    if (selected.adminToken !== config.adminToken || selected.enrollmentToken !== config.enrollmentToken) {
      // Startup owns runtime.lock; persist intentional environment rotation for local clients and later restarts.
      const temporary = join(state, '.component-' + randomUUID() + '.json');
      try {
        await createPrivate(temporary, selected);
        if (JSON.stringify(await readPrivate(path)) !== JSON.stringify(config)) throw inputError('Component state changed during startup. Inspect it before retrying.');
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      config = selected;
    }
    if (kind === 'orchestrator') {
      const { startServer } = await import('../../src/orchestrator/dist/orchestrator/server.js');
      service = await startServer({ db: join(state, 'orchestrator.sqlite'), host, port, project: config.project, adminToken: config.adminToken, enrollmentToken: config.enrollmentToken });
    } else {
      const { startFactoryServer } = await import('../../src/factory/dist/factory/server.js');
      service = await startFactoryServer({ db: join(state, 'factory.sqlite'), host, port, adminToken: config.adminToken });
    }
    const info = { service: kind, url: `http://${host.includes(':') ? '[' + host + ']' : host}:${service.server.address().port}`, stateDirectory: state, credentialsFile: path };
    if (lifecycle.ready) await lifecycle.ready(info, stop);
    else console.log(JSON.stringify(info));
    const finish = () => { void stop().catch(() => { console.error('Component shutdown failed. Inspect its state before restarting.'); process.exitCode = 1; }); };
    process.once('SIGINT', finish); process.once('SIGTERM', finish);
  } catch (error) { await stop(); throw error; }
}
