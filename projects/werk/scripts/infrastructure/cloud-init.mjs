import { readFile } from 'node:fs/promises';
import { loadDefinition, planDefinition } from '../system/definition.mjs';

const PROFILE = 'ubuntu-24.04';
const VERSION = /^(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/;
const invalid = message => Object.assign(new Error(message), { code: 'INVALID_INFRASTRUCTURE_INPUT', exitCode: 2 });
function artifactUrl(value, label) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f\\]/.test(value)) throw invalid(`${label}: expected a bounded HTTPS artifact URL without whitespace.`);
  let url; try { url = new URL(value); } catch { throw invalid(`${label}: invalid HTTPS artifact URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || /%/.test(url.pathname) || url.href !== value) throw invalid(`${label}: use a canonical HTTPS URL without credentials, query, fragment, custom port or encoded paths.`);
  return url;
}
export function validateArtifacts(options) {
  const allowed = ['file', 'release-version', 'release-url', 'release-sha256', 'node-url', 'node-sha256', 'architecture', 'json'];
  if (!options || Object.keys(options).some(key => !allowed.includes(key))) throw invalid('Unknown infrastructure option. Secrets are never accepted inline.');
  const version = options['release-version'];
  if (typeof version !== 'string' || !VERSION.test(version)) throw invalid('--release-version: use an exact stable major.minor.patch version.');
  const architecture = options.architecture;
  if (!['x86_64', 'arm64'].includes(architecture)) throw invalid('--architecture: expected x86_64 or arm64.');
  const releaseUrl = artifactUrl(options['release-url'], '--release-url');
  if (!releaseUrl.pathname.endsWith(`/v${version}/werk-${version}.tar.gz`) && !releaseUrl.pathname.endsWith(`/${version}/werk-${version}.tar.gz`)) throw invalid('--release-url: expected a versioned /vVERSION/werk-VERSION.tar.gz or /VERSION/werk-VERSION.tar.gz path.');
  const nodeUrl = artifactUrl(options['node-url'], '--node-url');
  const nodeArch = architecture === 'x86_64' ? 'x64' : 'arm64';
  const match = /^\/dist\/(v24\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5}))\/(.+)$/.exec(nodeUrl.pathname);
  if (nodeUrl.hostname !== 'nodejs.org' || !match || match[2] !== `node-${match[1]}-linux-${nodeArch}.tar.xz`) throw invalid('--node-url: use the official exact Node 24 Linux artifact matching --architecture.');
  for (const key of ['release-sha256', 'node-sha256']) if (typeof options[key] !== 'string' || !/^[a-fA-F0-9]{64}$/.test(options[key])) throw invalid(`--${key}: expected exactly 64 hexadecimal SHA-256 characters.`);
  return { profile: PROFILE, architecture, release: { version, url: releaseUrl.href, sha256: options['release-sha256'].toLowerCase() }, node: { version: match[1], architecture: nodeArch, url: nodeUrl.href, sha256: options['node-sha256'].toLowerCase() } };
}
export function serviceUnit(artifacts) {
  const executable = `/opt/werk/node/${artifacts.node.version}/bin/node`;
  const root = `/opt/werk/releases/${artifacts.release.version}`;
  return `[Unit]\nDescription=Werk single-host production system\nWants=network-online.target\nAfter=network-online.target\nRequiresMountsFor=/var/lib/werk\nStartLimitIntervalSec=300\nStartLimitBurst=3\n\n[Service]\nType=simple\nUser=werk\nGroup=werk\nWorkingDirectory=${root}\nEnvironmentFile=/etc/werk/runtime.env\nExecStart=${executable} ${root}/werk.mjs system start --no-open --json\nRestart=on-failure\nRestartSec=10\nKillMode=mixed\nTimeoutStopSec=180\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths=/var/lib/werk\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=multi-user.target\n`;
}
export async function prepare(options) {
  const artifacts = validateArtifacts(options);
  if (!options.file) throw invalid('--file is required.');
  const definition = await loadDefinition(options.file);
  if (definition.productionLines.some(line => line.workers.execution || line.workers.chat)) throw invalid('The VM bootstrap profile provisions mock workers. Configure provider installation and account access separately before opting a native line into live execution.');
  if (definition.environment !== 'native') throw invalid('The Ubuntu VM profile requires environment: native in the system definition.');
  const ports = [definition.factory.port, ...definition.productionLines.flatMap(line => [line.orchestrator.port, ...Array.from({ length: line.workers.count }, (_, index) => line.workers.statusPort + index)])];
  if (ports.some(port => port < 1024)) throw invalid('The non-root VM profile requires every service port to be at least 1024.');
  const plan = { ...artifacts, system: planDefinition(definition), paths: { release: `/opt/werk/releases/${artifacts.release.version}`, node: `/opt/werk/node/${artifacts.node.version}`, definition: '/etc/werk/system.yaml', environment: '/etc/werk/runtime.env', state: '/var/lib/werk' }, service: 'werk-system.service', access: { bind: '127.0.0.1', factoryPort: definition.factory.port, transport: 'SSH tunnel' }, storage: 'single-host SQLite; one supervisor; no HA or shared-state replicas' };
  return { artifacts, definition, plan };
}
export async function render(prepared) {
  const { artifacts, definition, plan } = prepared;
  const [provision, verifier] = await Promise.all([readFile(new URL('./provision.py', import.meta.url), 'utf8'), readFile(new URL('../release/verify.mjs', import.meta.url), 'utf8')]);
  const file = (path, content, permissions = '0600', owner = 'root:root') => ({ path, content, permissions, owner, defer: true });
  const cloud = {
    package_update: true,
    packages: ['ca-certificates', 'curl', 'git', 'python3', 'xz-utils'],
    groups: ['werk'],
    users: ['default', { name: 'werk', system: true, primary_group: 'werk', create_groups: true, lock_passwd: true, shell: '/usr/sbin/nologin', homedir: '/var/lib/werk', no_create_home: true }],
    write_files: [
      file('/etc/werk/artifacts.json', `${JSON.stringify(artifacts, null, 2)}\n`),
      file('/etc/werk/system.yaml', `${JSON.stringify(definition, null, 2)}\n`, '0640', 'root:werk'),
      file('/etc/werk/runtime.env', 'WERK_STATE_DIR=/var/lib/werk\nWERK_SYSTEM_FILE=/etc/werk/system.yaml\nWERK_LOG_OUTPUT=stream\nWERK_UPDATES=external\n', '0640', 'root:werk'),
      file('/etc/werk/provision.py', provision),
      file('/etc/werk/verify-release.mjs', verifier),
      file('/etc/systemd/system/werk-system.service', serviceUnit(artifacts), '0644'),
    ],
    runcmd: [['python3', '/etc/werk/provision.py']],
  };
  // JSON is valid YAML: data never becomes shell or cloud-init YAML syntax.
  return { ok: true, profile: PROFILE, plan, cloudConfig: `#cloud-config\n${JSON.stringify(cloud, null, 2)}\n` };
}
