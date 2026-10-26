import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @param {{platform?: string, actions?: string, exists?: (path: string) => boolean,
 * spawn?: (command: string, args: string[], options: {cwd: string, stdio: 'inherit'}) => {status: number | null, error?: Error}}} [ports] */
export function installBrowser({ platform = process.platform, actions = process.env.GITHUB_ACTIONS, exists = existsSync, spawn = spawnSync } = {}) {
  // Dependency setup belongs to disposable CI runners, never an installed Werk Home.
  if (platform !== 'linux' || actions !== 'true') throw Error('Browser dependency setup is restricted to Linux GitHub Actions runners.');
  const project = fileURLToPath(new URL('../../', import.meta.url));
  function execute(command, args) {
    const result = spawn(command, args, { cwd: project, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(`Browser setup command failed with exit status ${result.status ?? 'unknown'}.`);
  }
  // GitHub images use either direct sources or an apt mirror list. Preserve suites
  // and signing keys; replace only the slow mirror wherever apt reads it.
  for (const source of ['/etc/apt/sources.list', '/etc/apt/sources.list.d/ubuntu.sources', '/etc/apt/apt-mirrors.txt', '/etc/apt/apt-mirrors-security.txt']) {
    if (exists(source)) execute('sudo', ['sed', '-i', 's/azure\\.archive\\.ubuntu\\.com/archive.ubuntu.com/g', source]);
  }
  execute(process.execPath, [join(project, 'node_modules', 'playwright', 'cli.js'), 'install', '--with-deps', 'chromium']);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { installBrowser(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
