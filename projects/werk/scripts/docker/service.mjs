import { configureAccessFile } from './access.mjs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadSetup, readPrivate } from '../runtime/config.mjs';
const stateDir = '/state';
try {
  const role = process.argv[2];
  const env = { ...process.env };
  delete env.WERK_ACCESS_FILE; delete env.WERK_ADMIN_TOKEN; delete env.WERK_ENROLLMENT_TOKEN; delete env.WERK_URL;
  let args;
  if (role === 'orchestrator') {
    const { config, credentials } = await loadSetup(stateDir);
    if (config.runtime !== 'docker' || config.workers !== 1) throw Error('Docker release requires Docker mode and exactly one configured worker');
    Object.assign(env, credentials);
    await configureAccessFile(env, join(stateDir, 'access.json'));
    args = ['/app/src/orchestrator/dist/orchestrator/cli.js', 'serve', '--host', '0.0.0.0', '--port', '3000', '--db', join(stateDir, 'orchestrator.sqlite'), '--project', config.project];
  } else if (role === 'worker') {
    // Worker mount exposes only its own state and enrollment, never the admin token or server DB.
    const enrollment = await readPrivate(join(stateDir, 'enrollment.json'));
    if (enrollment?.schemaVersion !== 1 || enrollment.runtime !== 'docker' || typeof enrollment.enrollmentToken !== 'string' || !/^[a-f0-9]{64}$/.test(enrollment.enrollmentToken)
      || Object.keys(enrollment).some(key => !['schemaVersion', 'runtime', 'enrollmentToken'].includes(key))) throw Error('Invalid private worker enrollment configuration');
    env.WERK_URL = 'http://orchestrator:3000'; env.WERK_ENROLLMENT_TOKEN = enrollment.enrollmentToken;
    args = ['/app/src/worker/dist/worker/cli.js', 'run', '--state-dir', stateDir, '--status-host', '0.0.0.0', '--status-port', '4100'];
  } else throw Error('Unknown Docker service');
  const child = spawn(process.execPath, args, { stdio: 'inherit', env });
  child.on('error', () => { console.error('Unable to launch packaged service'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
} catch (error) { console.error(error instanceof Error ? error.message : 'Docker service failed'); process.exitCode = 1; }
