import { configureAccessFile } from './access.mjs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadSetup, readPrivate } from '../runtime/config.mjs';
import { loadSystem, factoryCredentials } from '../system/state.mjs';
try {
  const role = process.argv[2], env = { ...process.env };
  for (const key of Object.keys(env)) if (key === 'WERK_ACCESS_FILE' || key === 'WERK_ADMIN_TOKEN' || key === 'WERK_ENROLLMENT_TOKEN' || key === 'WERK_FACTORY_ADMIN_TOKEN' || /^WERK_LINE_SYSTEM_\d+_TOKEN$/.test(key)) delete env[key];
  let args;
  if (role === 'factory') {
    const definition = await loadSystem('/state');
    if (definition.environment !== 'docker') throw Error('Docker environment required');
    const credentials = await factoryCredentials('/state', definition);
    Object.assign(env, credentials.credentials, { WERK_FACTORY_ADMIN_TOKEN: credentials.adminToken });
    await configureAccessFile(env, '/state/factory/access.json');
    args = ['/app/src/factory/dist/factory/cli.js', 'serve', '--host', '0.0.0.0', '--port', '3100', '--db', '/state/factory/registry.sqlite'];
  } else if (role === 'orchestrator') {
    const { config, credentials } = await loadSetup('/state');
    if (config.runtime !== 'docker') throw Error('Docker environment required');
    Object.assign(env, credentials);
    await configureAccessFile(env, '/state/access.json');
    args = ['/app/src/orchestrator/dist/orchestrator/cli.js', 'serve', '--host', '0.0.0.0', '--port', '3000', '--db', '/state/orchestrator.sqlite', '--project', config.project];
  } else if (role === 'worker') {
    const enrollment = await readPrivate(join('/state', 'enrollment.json'));
    if (enrollment.schemaVersion !== 1 || enrollment.runtime !== 'docker' || !/^[a-f0-9]{64}$/.test(enrollment.enrollmentToken) || !/^http:\/\/line-[1-8]:3000$/.test(enrollment.url)) throw Error('Invalid worker enrollment configuration');
    env.WERK_URL = enrollment.url; env.WERK_ENROLLMENT_TOKEN = enrollment.enrollmentToken;
    args = ['/app/src/worker/dist/worker/cli.js', 'run', '--state-dir', '/state', '--status-host', '0.0.0.0', '--status-port', '4100'];
  } else throw Error('Unknown Docker system service');
  const child = spawn(process.execPath, args, { stdio: 'inherit', env });
  child.once('error', () => { console.error('Unable to launch packaged system service'); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
} catch (error) { console.error(error.message); process.exitCode = 1; }
