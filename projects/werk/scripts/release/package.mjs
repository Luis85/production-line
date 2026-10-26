import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainScript } from './verify.mjs';
import { createArchives } from './archives.mjs';
import { readReleaseChangelog } from './changelog.mjs';
import { homeWerkLauncher, homeWorkerLauncher } from './home-launchers.mjs';
import { environmentExample } from '../runtime/portable/environment.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const releaseFiles = ['werk.mjs', 'worker.mjs', 'werk-docker.sh', 'werk-docker.ps1', 'compose.release.yaml', 'compose.windows.yaml', 'Dockerfile.release', 'Dockerfile.release.dockerignore', 'examples/system.yaml', 'schemas/system.schema.json', 'schemas/request-gates.schema.json', 'scripts/release/verify.mjs', 'scripts/release/install.mjs', 'LICENSE', 'CHANGELOG.md'];
export const releaseTrees = ['bin/apps/factory', 'bin/apps/orchestrator', 'bin/apps/worker', 'scripts/security', 'scripts/infrastructure', 'scripts/system', 'scripts/runtime', 'scripts/docker', 'src/factory/dist', 'src/orchestrator/dist', 'src/worker/dist'];
export const releaseDocs = ['tutorials/worker-home-to-main', 'reference/worker-release-workflow', 'how-to/deliver-worker-release', 'explanation/local-delivery-worker', 'how-to/configure-delivery-readiness', 'reference/delivery-policy', 'how-to/publish-worker-candidates', 'how-to/manage-worker-processes', 'how-to/generate-readme', 'reports/worker-durable-sessions-review', 'how-to/mutation-testing', 'how-to/implement-feature', 'how-to/worker-consumption-limits', 'how-to/shared-feature-intake', 'reference/shared-feature-intake', 'how-to/team-feature-authoring', 'how-to/manage-model-tools', 'how-to/generate-storybook', 'reference/request-gates', 'how-to/rework-worker-requests', 'how-to/monitor-long-running-worker', 'how-to/project-agent-integrations', 'reference/model-interaction', 'how-to/answer-and-resume-worker', 'tutorials/worker-feature-lifecycle', 'reference/worker-run-metrics', 'how-to/project-worker', 'how-to/operate-project-worker', 'reference/feature-requests', 'reference/agent-definitions', 'reference/updates', 'reference/portable-apps', 'how-to/assemble-independent-components', 'how-to/use-worker-webview', 'how-to/run-codex-task', 'how-to/manage-access', 'reference/access-control', 'tutorials/linux-vm-first-task', 'how-to/operate-linux-vm', 'reference/infrastructure', 'explanation/twelve-factor', 'tutorials/system-from-yaml', 'reference/system-definition', 'explanation/core-entities', 'tutorials/local-first-task', 'tutorials/docker-first-task', 'how-to/maintain-runtime', 'how-to/monitor-runtime', 'how-to/upgrade-backup', 'how-to/operate-with-agents', 'reference/runtime-cli', 'reference/observability', 'reference/configuration', 'reference/releases', 'reference/security', 'explanation/runtime-layout', 'explanation/modes'].map(path => `docs/${path}.md`);
const releaseTemplates = { 'readme.md.txt': 'README.md', 'agents.md.txt': 'AGENTS.md', 'docs-index.md.txt': 'docs/index.md' };
const extensions = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.yaml', '.yml', '.sh', '.ps1', '.py', '.txt']);
const excluded = new Set(['.git', '.state', '.werk', '.env', '.DS_Store', 'backups', 'release']);
const hash = content => createHash('sha256').update(content).digest('hex');

async function collect(projectRoot, version) {
  const entries = [];
  let totalBytes = 0;
  async function visit(path, required = false) {
    const full = join(projectRoot, path);
    for (let ancestor = dirname(full); ancestor !== projectRoot && ancestor.startsWith(projectRoot + sep); ancestor = dirname(ancestor)) {
      if ((await lstat(ancestor)).isSymbolicLink()) throw Error(`Release inputs must be regular files or directories: ${path}`);
    }
    const stat = await lstat(full);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw Error(`Release inputs must be regular files or directories: ${path}`);
    const name = basename(path);
    const exampleKind = /^bin\/apps\/(factory|orchestrator|worker)\/\.env\.example$/.exec(path)?.[1];
    if (excluded.has(name) || name.startsWith('.env.') && !exampleKind || name.endsWith('.sqlite') || name.endsWith('.sqlite-wal') || name.endsWith('.sqlite-shm')) return;
    if (stat.isDirectory()) {
      for (const child of (await readdir(full)).sort()) await visit(`${path}/${child}`);
      return;
    }
    if (!required && !exampleKind && !extensions.has(extname(name)) && !['LICENSE', 'NOTICE'].includes(name)) return;
    // Runtime dependencies are copied only inside a built application's dist tree.
    if (stat.size > 32 * 1024 * 1024) throw Error(`Release file exceeds 32 MiB: ${path}`);
    totalBytes += stat.size;
    if (totalBytes > 256 * 1024 * 1024 || entries.length >= 10000) throw Error('Release exceeds packaging limits (256 MiB / 10,000 files)');
    const content = await readFile(full);
    if (exampleKind && content.toString('utf8') !== environmentExample(exampleKind)) throw Error('Portable environment example differs from the credential-free template; rebuild before packaging.');
    entries.push({ path, content, mode: name.endsWith('.sh') || ['werk.mjs', 'worker.mjs'].includes(path) || /\/cli\.m?js$/.test(path) ? 0o755 : 0o644 });
  }
  for (const path of releaseFiles) await visit(path, true);
  for (const path of releaseTrees) await visit(path);
  for (const app of ['factory', 'orchestrator', 'worker']) {
    const cli = `src/${app}/dist/${app}/cli.js`;
    if (!entries.some(entry => entry.path === cli)) throw Error(`Missing built application ${cli}; run npm run build first`);
    if (!entries.some(entry => entry.path === `bin/apps/${app}/cli.mjs`)) throw Error(`Missing portable application ${app}; run npm run build first`);
  }
  for (const path of releaseDocs) await visit(path, true);
  for (const [template, path] of Object.entries(releaseTemplates)) {
    const source = join(projectRoot, 'scripts/release/templates', template);
    if (!(await lstat(source)).isFile()) throw Error(`Release template must be a regular file: ${template}`);
    entries.push({ path, content: Buffer.from((await readFile(source, 'utf8')).replaceAll('{{version}}', version)), mode: 0o644 });
  }
  // The standalone guide must match the self-contained page served by the runtime.
  const builtGuide = entries.find(entry => entry.path === 'src/factory/dist/factory/public/guide.html');
  if (!builtGuide) throw Error('Missing compiled system guide; run npm run build first');
  totalBytes += builtGuide.content.length;
  if (totalBytes > 256 * 1024 * 1024) throw Error('Release exceeds packaging limits (256 MiB)');
  entries.push({ path: 'src/guide/public/index.html', content: builtGuide.content, mode: 0o644 });
  const human = path => path === 'worker.mjs' || ['README.md', 'AGENTS.md', 'LICENSE', 'CHANGELOG.md'].includes(path) || path.startsWith('docs/');
  const mapped = new Map(entries.map(entry => [entry.path, human(entry.path) ? entry.path : 'runtime/' + entry.path]));
  const destinations = new Set(mapped.values());
  const homeEntries = entries.map(entry => {
    const path = mapped.get(entry.path);
    if (!entry.path.endsWith('.md') || entry.path.startsWith('src/') || /^bin\/apps\/[^/]+\/src\//.test(entry.path)) return { ...entry, path };
    const text = entry.content.toString('utf8').replace(/(!?\[[^\]]+\]\()([^\s)]+)([^)]*\))/g, (match, before, target, after) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return match;
      const suffixIndex = target.search(/[?#]/), local = suffixIndex < 0 ? target : target.slice(0, suffixIndex), suffix = suffixIndex < 0 ? '' : target.slice(suffixIndex);
      const original = posix.normalize(posix.join(posix.dirname(/^bin\/apps\/[^/]+\/README\.md$/.test(entry.path) ? 'docs/reference/portable-apps.md' : entry.path), decodeURIComponent(local)));
      const destination = mapped.get(original) ?? (destinations.has(original) ? original : undefined);
      if (!destination) throw Error(`Release documentation link is not packaged: ${entry.path} -> ${target}`);
      const rewritten = posix.relative(posix.dirname(path), destination).split('/').map(part => encodeURIComponent(part)).join('/');
      return before + rewritten + suffix + after;
    });
    return { ...entry, path, content: Buffer.from(text) };
  });
  homeEntries.find(entry => entry.path === 'worker.mjs').content = Buffer.from(homeWorkerLauncher);
  homeEntries.push({ path: 'werk.mjs', mode: 0o755, content: Buffer.from(homeWerkLauncher) });
  const dockerShell = '#!/usr/bin/env bash\nset -euo pipefail\nhome_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"\nforward=("$@")\nexplicit=false; for arg in "$@"; do [[ "$arg" != --state-dir ]] || explicit=true; done\nif [[ "$explicit" == false ]]; then state=docker; [[ "${1:-}" != system ]] || state=docker-system; forward+=(--state-dir "$home_dir/state/$state"); fi\nexec bash "$home_dir/runtime/werk-docker.sh" "${forward[@]}"\n';
  const dockerPowerShell = '$ErrorActionPreference = "Stop"\n$forward = @($args)\nif ("--state-dir" -notin $args) { $state = if ($args.Count -and $args[0] -eq "system") { "docker-system" } else { "docker" }; $forward += @("--state-dir", (Join-Path $PSScriptRoot "state/$state")) }\n& "$PSScriptRoot/runtime/werk-docker.ps1" @forward\nexit $LASTEXITCODE\n';
  for (const [name, text] of [['werk-docker.sh', dockerShell], ['werk-docker.ps1', dockerPowerShell]]) homeEntries.push({ path: name, mode: name.endsWith('.sh') ? 0o755 : 0o644, content: Buffer.from(text) });
  return homeEntries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function sourceCommit(projectRoot) {
  try {
    if (execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) return null;
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}
export async function packageRelease(projectRoot = root, output = join(projectRoot, 'release')) {
  const info = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(info.version)) throw Error('Package version is not a safe release version');
  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${info.version}`) throw Error('Release tag must match package.json version');
  const changelog = await readReleaseChangelog(projectRoot, { version: info.version });
  const entries = await collect(projectRoot, info.version);
  if (entries.find(entry => entry.path === 'CHANGELOG.md').content.toString('utf8') !== changelog.markdown) throw Error('CHANGELOG.md changed while preparing the release; retry packaging');
  const manifest = { schemaVersion: 1, name: 'werk', layout: 'werk-home-v1', version: info.version, updateProtocol: 2, stateFormat: 1, node: '>=24.0.0 <25', sourceCommit: sourceCommit(projectRoot), files: entries.map(({path,content,mode}) => ({ path, bytes: content.length, sha256: hash(content), mode: mode.toString(8) })) };
  entries.push({ path: 'release-manifest.json', content: Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), mode: 0o644 });
  const prefix = `werk-${info.version}`;
  const archiveEntries = entries;
  const built = await createArchives(archiveEntries);
  const archives = [{ name: `${prefix}.tar.gz`, content: built.tarGzip }, { name: `${prefix}.zip`, content: built.zip }];
  const repository = process.env.GITHUB_REPOSITORY || 'Luis85/production-line';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw Error('Invalid release repository');
  const installerTemplate = await readFile(join(projectRoot, 'scripts/release/install.mjs'), 'utf8');
  if (!installerTemplate.includes('/* RELEASE_CONFIG */ null')) throw Error('Missing installer configuration marker');
  const installer = { name: 'install.mjs', content: Buffer.from(installerTemplate.replace('/* RELEASE_CONFIG */ null', JSON.stringify({ version: info.version, repository, sha256: hash(built.tarGzip), layout: 'werk-home-v1' }))) };
  const assets = [...archives, installer];
  const staging = join(dirname(output), `.${basename(output)}-${process.pid}-${Date.now()}`);
  await mkdir(staging, { recursive: true });
  try {
    for (const archive of assets) await writeFile(join(staging, archive.name), archive.content);
    await writeFile(join(staging, 'SHA256SUMS'), assets.map(archive => `${hash(archive.content)}  ${archive.name}\n`).join(''));
    await writeFile(join(staging, 'RELEASE-NOTES.md'), changelog.notes);
    await mkdir(output, { recursive: true });
    for (const name of [...assets.map(archive => archive.name), 'SHA256SUMS', 'RELEASE-NOTES.md']) await rename(join(staging, name), join(output, name));
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { version: info.version, output, files: entries.length, artifacts: assets.map(({name,content}) => ({name,bytes:content.length,sha256:hash(content)})), sourceCommit: manifest.sourceCommit };
}
if (isMainScript(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw Error('Usage: node scripts/release/package.mjs');
    console.log(JSON.stringify(await packageRelease(), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
