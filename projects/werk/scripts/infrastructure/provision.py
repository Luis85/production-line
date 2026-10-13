"""Ubuntu 24.04 first-boot installer. No application build or package install."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import pwd
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time

MAX_ARCHIVE = 300 * 1024 * 1024
MAX_RELEASE = 256 * 1024 * 1024
MAX_NODE = 512 * 1024 * 1024


def verify_download(path, expected):
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_ARCHIVE:
        raise ValueError('Artifact is not a bounded regular file')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    if digest.hexdigest() != expected:
        raise ValueError('Artifact SHA-256 mismatch; nothing extracted')


def safe_name(value, prefix):
    parts = value.rstrip('/').split('/')
    if len(value) > 4096 or not parts or parts[0] != prefix or any(not part or part in ('.', '..') for part in parts) or any(ord(char) < 32 or ord(char) == 127 for char in value) or '\\' in value or ':' in value:
        raise ValueError('Unsafe artifact path or unexpected archive root')
    return PurePosixPath(*parts)


def extract_archive(archive, destination, prefix, node=False):
    """Validate all headers before extraction; never invoke tarfile.extract()."""
    if destination.exists():
        raise ValueError('Extraction destination must be new')
    with tarfile.open(archive, 'r:*') as source:
        members, seen, total = [], set(), 0
        for member in source:
            path = safe_name(member.name, prefix)
            key = str(path)
            if key in seen or len(seen) >= 10000:
                raise ValueError('Duplicate or excessive archive entries')
            seen.add(key)
            if member.size < 0:
                raise ValueError('Invalid archive member size')
            total += member.size
            limit = MAX_NODE if node else MAX_RELEASE
            if total > limit or member.size > (256 if node else 32) * 1024 * 1024:
                raise ValueError('Archive exceeds extracted byte bounds')
            # Official Node archives have npm links. Only two regular files are
            # selected; ignored entries can never create a filesystem object.
            selected = not node or key in (prefix + '/bin/node', prefix + '/LICENSE')
            if selected and not (member.isfile() or member.isdir()):
                raise ValueError('Links and special release files are forbidden')
            if not node and not (member.isfile() or member.isdir()):
                raise ValueError('Links and special release files are forbidden')
            if selected and member.isfile():
                members.append((member, path))
        if node and {str(path) for _, path in members} != {prefix + '/bin/node', prefix + '/LICENSE'}:
            raise ValueError('Node archive lacks its regular binary or license')
        if not node and prefix + '/release-manifest.json' not in seen:
            raise ValueError('Release archive lacks its manifest')
        # A file cannot also be another file's ancestor.
        files = {str(path) for member, path in members}
        if any(str(parent) in files for _, path in members for parent in path.parents):
            raise ValueError('Archive file/directory collision')
        destination.mkdir(mode=0o700)
        for member, path in members:
            target = destination.joinpath(*path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as incoming, target.open('xb') as outgoing:
                shutil.copyfileobj(incoming, outgoing, 1024 * 1024)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
    return destination / prefix


def check_manifest_version(root, expected):
    manifest = json.loads((root / 'release-manifest.json').read_text())
    if manifest.get('version') != expected or manifest.get('name') != 'werk' or manifest.get('node') != '>=24.0.0 <25':
        raise ValueError('Release manifest version or Node contract mismatch')


def download(artifact, target):
    subprocess.run(['curl', '--proto', '=https', '--proto-redir', '=https', '--fail', '--silent', '--show-error', '--location', '--max-redirs', '3', '--connect-timeout', '30', '--max-time', '300', '--max-filesize', str(MAX_ARCHIVE), '--output', str(target), artifact['url']], check=True)
    verify_download(target, artifact['sha256'])


def readonly_tree(root):
    for directory, _, files in os.walk(root):
        for name in files:
            path = Path(directory) / name
            path.chmod(0o555 if path.stat().st_mode & 0o111 else 0o444)
        Path(directory).chmod(0o555)


def await_ready(command, timeout=120, run=subprocess.run, clock=time.monotonic, sleep=time.sleep):
    """A spawned systemd process is not proof of an authenticated healthy fleet."""
    deadline = clock() + timeout
    while clock() < deadline:
        try:
            result = run(command, capture_output=True, text=True, timeout=max(0.1, min(15, deadline - clock())))
            status = json.loads(result.stdout) if result.returncode == 0 else {}
            if status.get('ok') is True and status.get('state') == 'running':
                return
        except (subprocess.TimeoutExpired, json.JSONDecodeError):
            pass
        remaining = deadline - clock()
        if remaining > 0:
            sleep(min(2, remaining))
    raise RuntimeError('Werk did not become authenticated and ready within the startup deadline; inspect the private state and systemd journal')


def provision():
    if os.geteuid() != 0:
        raise ValueError('Provisioning requires root through cloud-init')
    os_release = dict(line.rstrip().split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    if os_release.get('ID', '').strip('"') != 'ubuntu' or os_release.get('VERSION_ID', '').strip('"') != '24.04':
        raise ValueError('This profile supports Ubuntu 24.04 only')
    config = json.loads(Path('/etc/werk/artifacts.json').read_text())
    if platform.machine() != {'x86_64': 'x86_64', 'arm64': 'aarch64'}[config['architecture']]:
        raise ValueError('VM architecture does not match the selected artifacts')
    base = Path('/opt/werk')
    release = base / 'releases' / config['release']['version']
    node = base / 'node' / config['node']['version']
    if release.exists() or node.exists():
        raise ValueError('Versioned installation already exists; use the documented maintenance procedure')
    base.mkdir(mode=0o755, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.provision-', dir=base) as temporary:
        scratch = Path(temporary)
        download(config['release'], scratch / 'werk.tar.gz')
        download(config['node'], scratch / 'node.tar.xz')
        staged_release = extract_archive(scratch / 'werk.tar.gz', scratch / 'release', 'werk-' + config['release']['version'])
        node_prefix = 'node-' + config['node']['version'] + '-linux-' + config['node']['architecture']
        staged_node = extract_archive(scratch / 'node.tar.xz', scratch / 'node', node_prefix, node=True)
        binary = staged_node / 'bin/node'
        binary.chmod(0o755)
        actual_version = subprocess.run([str(binary), '--version'], check=True, capture_output=True, text=True).stdout.strip()
        if actual_version != config['node']['version']:
            raise ValueError('Node binary does not match the selected version')
        check_manifest_version(staged_release, config['release']['version'])
        subprocess.run([str(binary), '/etc/werk/verify-release.mjs', str(staged_release)], check=True, stdout=subprocess.DEVNULL)
        readonly_tree(staged_release)
        readonly_tree(staged_node)
        release.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        node.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        staged_release.rename(release)
        staged_node.rename(node)
    identity = pwd.getpwnam('werk')
    state = Path('/var/lib/werk')
    if state.is_symlink() or (state.exists() and not state.is_dir()):
        raise ValueError('State must be a real private directory')
    state.mkdir(mode=0o700, exist_ok=True)
    os.chown(state, identity.pw_uid, identity.pw_gid)
    state.chmod(0o700)
    # Provision secrets once as the runtime identity, never in user-data or logs.
    subprocess.run(['runuser', '-u', 'werk', '--', 'env', '-i', 'PATH=/usr/bin:/bin', 'HOME=/var/lib/werk', 'WERK_UPDATES=external', str(node / 'bin/node'), str(release / 'werk.mjs'), 'system', 'setup', '--file', '/etc/werk/system.yaml', '--state-dir', str(state), '--json'], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', '--now', 'werk-system.service'], check=True)
    doctor = ['runuser', '-u', 'werk', '--', 'env', '-i', 'PATH=/usr/bin:/bin', 'HOME=/var/lib/werk', 'WERK_UPDATES=external', str(node / 'bin/node'), str(release / 'werk.mjs'), 'system', 'doctor', '--file', '/etc/werk/system.yaml', '--state-dir', str(state), '--json']
    try:
        await_ready(doctor)
    except RuntimeError:
        subprocess.run(['systemctl', 'stop', 'werk-system.service'], check=False, timeout=200)
        raise


if __name__ == '__main__':
    provision()
