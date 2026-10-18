import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { nodeServiceHost } from '../../src/worker/dist/worker/infrastructure/processes/node-host.js';

const mode = process.argv[2];
if (mode === 'descendant') {
  process.on('SIGTERM', () => {}); process.send?.('ready'); setInterval(() => {}, 1000);
} else if (mode === 'stalled-host') {
  process.stdin.resume(); process.on('SIGTERM', () => {});
  const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  descendant.once('message', () => {
    process.stdout.write(JSON.stringify({ type: 'started' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'output', stream: 'stdout', text: JSON.stringify({ pid: process.pid, descendant: descendant.pid }) }) + '\n');
  });
  setInterval(() => {}, 1000);
} else if (mode === 'driver') {
  const input = JSON.parse(process.argv[3]);
  const handle = nodeServiceHost(input.scope.worktree).start({ ...input, onEvent(event) { if (event.type === 'output') process.stdout.write(event.text); } });
  await handle.started;
} else {
  const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const server = createServer((_request, response) => response.end('service response'));
  descendant.once('message', () => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing service address');
    process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, host: process.ppid, descendant: descendant.pid, port: address.port, secret: process.env.WERK_TEST_SERVICE_SECRET ?? null, args: process.argv.slice(3) }) + '\n');
    if (mode === 'leader-exit') setTimeout(() => process.exit(0), 50);
  }));
}
