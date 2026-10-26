import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Dependency setup belongs to disposable CI runners, never an installed Werk Home.
if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true') {
  console.error('Browser dependency setup is restricted to Linux GitHub Actions runners.');
  process.exit(1);
}
const project = fileURLToPath(new URL('../../', import.meta.url));
function execute(command, args) {
  const result = spawnSync(command, args, { cwd: project, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// Preserve suites, signing keys and package versions; replace only the slow mirror.
for (const source of ['/etc/apt/sources.list', '/etc/apt/sources.list.d/ubuntu.sources']) {
  if (existsSync(source)) execute('sudo', ['sed', '-i', 's/azure\\.archive\\.ubuntu\\.com/archive.ubuntu.com/g', source]);
}
execute(process.execPath, [join(project, 'node_modules', 'playwright', 'cli.js'), 'install', '--with-deps', 'chromium']);
