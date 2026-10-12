import { join } from 'node:path';
import { startRuntime } from '../runtime/supervisor.mjs';

const abort = new AbortController(); let started = false, factory, closing;
function stop() { abort.abort(); if (factory) closing ??= factory.close().finally(() => process.disconnect?.()); }
process.on('disconnect', stop); process.on('SIGINT', stop); process.on('SIGTERM', stop);
process.on('message', async message => {
  if (message?.command === 'stop') { stop(); return; }
  if (message?.command !== 'start' || started) return;
  started = true;
  try {
    if (message.role === 'line') await startRuntime(message.stateDir, { noOpen: true, signal: abort.signal, logOutput: message.logOutput, emit: value => {
      if (!process.connected) return;
      if (value.event === 'ready') process.send({ event: 'ready' });
      else if (value.event === 'service_log' && message.logOutput !== 'file') process.send(value, () => {});
    } });
    else if (message.role === 'factory') {
      abort.signal.throwIfAborted();
      const { startFactoryServer } = await import(new URL('../../src/factory/dist/factory/server.js', import.meta.url));
      const { loadAccessFile } = await import(new URL('../../src/factory/dist/shared/http/access.js', import.meta.url));
      abort.signal.throwIfAborted();
      factory = await startFactoryServer({ db: join(message.stateDir, 'factory', 'registry.sqlite'), host: '127.0.0.1', port: message.port,
        access: await loadAccessFile(join(message.stateDir, 'factory', 'access.json'), true), adminToken: message.credentials.adminToken, credentials: message.credentials.credentials });
      if (abort.signal.aborted) stop(); else if (process.connected) process.send({ event: 'ready' });
      return;
    } else throw Error('Unknown system child role.');
  } catch { process.exitCode = abort.signal.aborted ? 0 : 1; }
  finally { if (!factory && process.connected) process.disconnect(); }
});
