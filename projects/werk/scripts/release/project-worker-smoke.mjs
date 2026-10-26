// Maintainer qualification of one central Home; never installs a worker inside a project.
if (process.argv.includes('--native')) await import('./project-worker-native-smoke.mjs');
else {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const execute = promisify(execFile), home = resolve(process.env.WERK_WORKER_HOME_ROOT ?? '.');
  const scripts = fileURLToPath(new URL('./', import.meta.url));
  const image = 'node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b';
  const result = await execute('docker', ['run', '--rm', '--mount', `type=bind,src=${home},dst=/Home,readonly`, '--mount', `type=bind,src=${scripts},dst=/maintainer,readonly`, '--env', 'WERK_WORKER_HOME_ROOT=/Home', '--workdir', '/tmp', image, 'node', '/maintainer/project-worker-native-smoke.mjs'], { timeout: 300000, maxBuffer: 2097152 });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
}
