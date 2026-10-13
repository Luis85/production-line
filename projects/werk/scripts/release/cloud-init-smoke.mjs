/** Real cloud-init boot qualification. Requires Linux, QEMU, cloud-localds, SSH and OpenSSL. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:https';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { verifyRelease } from './verify.mjs';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--root' || args[2] !== '--archives') throw Error('Usage: node scripts/release/cloud-init-smoke.mjs --root EXTRACTED_RELEASE --archives ARCHIVE_DIRECTORY');
if (process.platform !== 'linux') throw Error('VM qualification requires a Linux host');
const root = resolve(args[1]), archives = resolve(args[3]);
await verifyRelease(root);
const { prepare, render } = await import(pathToFileURL(join(root, 'scripts/infrastructure/cloud-init.mjs')));
const version = JSON.parse(await readFile(join(root, 'release-manifest.json'), 'utf8')).version;
const archive = join(archives, `werk-${version}.tar.gz`);
const scratch = await mkdtemp(join(tmpdir(), 'werk-vm-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, vm, vmExit;
let connected = false;
let stage = 'prepare';
async function command(program, arguments_, timeout = 120000, input) {
  const child = spawn(program, arguments_, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1048576) child.kill('SIGKILL'); });
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 1048576) child.kill('SIGKILL'); });
  // Early SSH/tool failure may close stdin before the acceptance probe is sent.
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    // Never include command arguments, private user-data or guest output in errors.
    if (code !== 0) throw Error(`${program} failed during ${stage} (exit ${code})`);
    return stdout;
  } finally { clearTimeout(timer); }
}
async function download(url, destination, maxBytes) {
  await command('curl', ['--proto', '=https', '--proto-redir', '=https', '--fail', '--silent', '--show-error', '--location', '--max-redirs', '3', '--max-filesize', String(maxBytes), '--max-time', '600', '--output', destination, url], 620000);
}
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const key = join(scratch, 'client-key'), hostKey = join(scratch, 'host-key');
const knownHosts = join(scratch, 'known-hosts');
const sshPort = 22222;
const ssh = ['-i', key, '-p', String(sshPort), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`, 'ubuntu@127.0.0.1'];
try {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const archiveHash = await digest(archive);
  const sums = await readFile(join(archives, 'SHA256SUMS'), 'utf8');
  assert.ok(sums.split('\n').some(line => line === `${archiveHash}  werk-${version}.tar.gz`), 'Candidate checksum mismatch');
  for (const executable of ['qemu-system-x86_64', 'qemu-img', 'cloud-localds', 'ssh', 'ssh-keygen', 'openssl', 'curl', 'nc']) await command('which', [executable]);
  await command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  await command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  await writeFile(knownHosts, `[127.0.0.1]:${sshPort} ${(await readFile(hostKey + '.pub', 'utf8')).trim()}\n`, { mode: 0o600 });
  const cert = join(scratch, 'fixture-cert.pem'), certKey = join(scratch, 'fixture-key.pem');
  await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Werk disposable qualification fixture', '-addext', 'subjectAltName=IP:10.0.2.100', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', certKey, '-out', cert]);
  server = createServer({ key: await readFile(certKey), cert: await readFile(cert) }, (request, response) => {
    if (request.method !== 'GET' || request.url !== `/v${version}/werk-${version}.tar.gz`) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/gzip' });
    const stream = createReadStream(archive); stream.on('error', () => response.destroy()); stream.pipe(response);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const prepared = await prepare({ file: join(root, 'examples/system.yaml'), architecture: 'x86_64', 'release-version': version, 'release-url': `https://10.0.2.100/v${version}/werk-${version}.tar.gz`, 'release-sha256': archiveHash, 'node-url': 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz', 'node-sha256': '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647' });
  const cloud = JSON.parse((await render(prepared)).cloudConfig.replace(/^#cloud-config\n/, ''));
  // Only fixture access changes: keep the generated installer and service unchanged.
  cloud.ssh_authorized_keys = [(await readFile(key + '.pub', 'utf8')).trim()];
  cloud.ssh_keys = { ed25519_private: await readFile(hostKey, 'utf8'), ed25519_public: await readFile(hostKey + '.pub', 'utf8') };
  cloud.ssh_pwauth = false;
  cloud.disable_root = true;
  cloud.ca_certs = { trusted: [await readFile(cert, 'utf8')] };
  await writeFile(join(scratch, 'user-data'), '#cloud-config\n' + JSON.stringify(cloud), { mode: 0o600 });
  await writeFile(join(scratch, 'meta-data'), 'instance-id: werk-qualification\nlocal-hostname: werk-qualification\n');
  await command('cloud-localds', [join(scratch, 'seed.img'), join(scratch, 'user-data'), join(scratch, 'meta-data')]);
  stage = 'download Ubuntu image';
  const imageBase = 'https://cloud-images.ubuntu.com/noble/current';
  await download(`${imageBase}/SHA256SUMS`, join(scratch, 'image-sums'), 1048576);
  const imageName = 'noble-server-cloudimg-amd64.img';
  const checksumLine = (await readFile(join(scratch, 'image-sums'), 'utf8')).split('\n').find(line => line.endsWith(` *${imageName}`) || line.endsWith(`  ${imageName}`));
  assert.match(checksumLine ?? '', /^[a-f0-9]{64} [ *]/, 'Official Ubuntu checksum unavailable');
  const imageHash = checksumLine.slice(0, 64);
  await download(`${imageBase}/${imageName}`, join(scratch, 'base.img'), 1200 * 1024 * 1024);
  assert.equal(await digest(join(scratch, 'base.img')), imageHash, 'Ubuntu image checksum mismatch');
  await command('qemu-img', ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', join(scratch, 'base.img'), join(scratch, 'disk.qcow2'), '12G']);
  let accelerator = 'tcg';
  try { await access('/dev/kvm', 6); accelerator = 'kvm'; } catch { /* Software emulation is slower but still boots a real VM. */ }
  stage = 'boot cloud-init';
  vm = spawn('qemu-system-x86_64', ['-machine', `q35,accel=${accelerator}`, '-cpu', accelerator === 'kvm' ? 'host' : 'max', '-smp', '2', '-m', '2048', '-display', 'none', '-serial', 'file:' + join(scratch, 'serial.log'), '-monitor', 'none', '-no-reboot', '-drive', `file=${join(scratch, 'disk.qcow2')},if=virtio,format=qcow2`, '-drive', `file=${join(scratch, 'seed.img')},if=virtio,format=raw`, '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:${sshPort}-:22,guestfwd=tcp:10.0.2.100:443-cmd:nc 127.0.0.1 ${server.address().port}`, '-device', 'virtio-net-pci,netdev=net0'], { stdio: 'ignore' });
  vmExit = new Promise(resolve => { vm.once('error', () => resolve(-1)); vm.once('close', resolve); });
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    if (vm.exitCode !== null) throw Error('QEMU exited before SSH became available');
    try { await command('ssh', [...ssh, 'true'], 6000); connected = true; break; } catch { await delay(2000); }
  }
  assert.ok(connected, 'SSH boot deadline exceeded');
  await command('ssh', [...ssh, 'sudo cloud-init status --wait --long'], 15 * 60 * 1000);
  stage = 'guest acceptance';
  const guest = await readFile(new URL('./cloud-init-guest.mjs', import.meta.url), 'utf8');
  // Node reads the acceptance probe from stdin; no harness files are added to the release.
  const report = JSON.parse((await command('ssh', [...ssh, `sudo /opt/werk/node/${prepared.artifacts.node.version}/bin/node --input-type=module`], 300000, guest)).trim());
  assert.equal(report.ok, true);
  console.log(JSON.stringify({ ...report, accelerator, releaseSha256: archiveHash, nodeSha256: prepared.artifacts.node.sha256, imageSha256: imageHash, imageUrl: `${imageBase}/${imageName}`, fixtureTlsVerified: true, sshHostKeyVerified: true }));
} catch (error) {
  const diagnostics = {};
  if (connected) {
    try {
      const status = JSON.parse(await command('ssh', [...ssh, 'sudo cloud-init status --format json || true'], 10000));
      for (const name of ['status', 'extended_status', 'boot_status_code']) if (typeof status[name] === 'string') diagnostics[name] = status[name].slice(0, 120);
    } catch { /* Keep the original qualification failure. */ }
    try {
      const service = await command('ssh', [...ssh, 'sudo systemctl show werk-system.service --property=ActiveState,SubState,Result,ExecMainStatus'], 10000);
      diagnostics.service = Object.fromEntries(service.trim().split('\n').map(line => line.split('=')));
    } catch { /* Service may not have been installed. */ }
  }
  console.log(JSON.stringify({ ok: false, stage, message: error instanceof Error ? error.message : 'VM qualification failed', diagnostics }));
  process.exitCode = 1;
} finally {
  if (vm) { vm.kill('SIGTERM'); const timer = setTimeout(() => vm.kill('SIGKILL'), 5000); await vmExit; clearTimeout(timer); }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(scratch, { recursive: true, force: true });
}
