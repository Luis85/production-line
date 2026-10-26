import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('provision', Path(__file__).resolve().parents[2] / 'scripts/infrastructure/provision.py')
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


class ArchiveSafety(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='werk-vm-archive-')
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def archive(self, entries):
        archive = self.root / 'artifact.tar.gz'
        with tarfile.open(archive, 'w:gz') as target:
            for name, kind, data in entries:
                member = tarfile.TarInfo(name)
                member.type = kind
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    member.linkname = '/tmp/escape'
                elif kind == tarfile.REGTYPE:
                    member.size = len(data)
                target.addfile(member, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
        return archive

    def manifest(self, version='0.1.0'):
        return ('werk-0.1.0/release-manifest.json', tarfile.REGTYPE, json.dumps({'name': 'werk', 'version': version, 'node': '>=24.0.0 <25'}).encode())

    def test_valid_archive_and_hash(self):
        archive = self.archive([self.manifest(), ('werk-0.1.0/hello.txt', tarfile.REGTYPE, b'hello')])
        provision.verify_download(archive, hashlib.sha256(archive.read_bytes()).hexdigest())
        extracted = provision.extract_archive(archive, self.root / 'out', 'werk-0.1.0')
        self.assertEqual((extracted / 'hello.txt').read_text(), 'hello')
        provision.check_manifest_version(extracted, '0.1.0')
        with self.assertRaises(ValueError):
            provision.check_manifest_version(extracted, '0.2.0')

    def test_flat_home_extracts_directly_and_preserves_runtime_boundaries(self):
        manifest = {'name': 'werk', 'version': '0.1.0', 'node': '>=24.0.0 <25', 'layout': 'werk-home-v1', 'updateProtocol': 2}
        archive = self.archive([
            ('release-manifest.json', tarfile.REGTYPE, json.dumps(manifest).encode()),
            ('worker.mjs', tarfile.REGTYPE, b'worker launcher'),
            ('README.md', tarfile.REGTYPE, b'Home guidance'),
            ('runtime/werk.mjs', tarfile.REGTYPE, b'system launcher'),
            ('runtime/bin/apps/factory/cli.mjs', tarfile.REGTYPE, b'factory'),
            ('docs/index.md', tarfile.REGTYPE, b'Handbook'),
        ])
        extracted = provision.extract_archive(archive, self.root / 'out')
        self.assertEqual(extracted, self.root / 'out')
        self.assertEqual((extracted / 'runtime/werk.mjs').read_text(), 'system launcher')
        self.assertFalse((extracted / 'werk-0.1.0').exists())
        provision.check_manifest_version(extracted, '0.1.0')
        manifest['updateProtocol'] = 1
        (extracted / 'release-manifest.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'contract mismatch'):
            provision.check_manifest_version(extracted, '0.1.0')

    def test_flat_home_rejects_mutable_payload_and_unsafe_paths_before_extraction(self):
        manifest = ('release-manifest.json', tarfile.REGTYPE, b'{}')
        for path in ['state/worker/credentials.json', 'projects/existing/value.md', 'backups/state.json', 'werk-0.1.0/runtime/werk.mjs',
                     '../outside', '/tmp/escape', 'runtime/../state/identity.json', 'runtime//unsafe', 'runtime/./unsafe', 'README.md/nested']:
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    provision.extract_archive(self.archive([manifest, (path, tarfile.REGTYPE, b'bad')]), self.root / 'out')
                self.assertFalse((self.root / 'out').exists())
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE]:
            with self.assertRaises(ValueError):
                provision.extract_archive(self.archive([manifest, ('runtime/escape', kind, b'')]), self.root / 'out')
            self.assertFalse((self.root / 'out').exists())

    def test_hash_failure_before_extract(self):
        archive = self.archive([self.manifest()])
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            provision.verify_download(archive, '0' * 64)
        self.assertFalse((self.root / 'out').exists())

    def test_unsafe_paths_and_roots(self):
        for path in ['/tmp/escape', '../escape', 'werk-0.1.0/../escape', 'werk-0.1.0//escape', 'werk-0.1.0/./escape', 'wrong/escape', 'werk-0.1.0/a\\b', 'werk-0.1.0/x:y', 'werk-0.1.0/a\nb']:
            with self.subTest(path=path):
                archive = self.archive([self.manifest(), (path, tarfile.REGTYPE, b'bad')])
                with self.assertRaises(ValueError):
                    provision.extract_archive(archive, self.root / 'out', 'werk-0.1.0')
                self.assertFalse((self.root / 'out').exists())

    def test_links_devices_fifo_and_duplicates(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE]:
            archive = self.archive([self.manifest(), ('werk-0.1.0/escape', kind, b'')])
            with self.assertRaises(ValueError):
                provision.extract_archive(archive, self.root / 'out', 'werk-0.1.0')
            self.assertFalse((self.root / 'out').exists())
        archive = self.archive([self.manifest(), self.manifest()])
        with self.assertRaises(ValueError):
            provision.extract_archive(archive, self.root / 'out', 'werk-0.1.0')

    def test_limits_and_collisions(self):
        archive = self.archive([self.manifest(), ('werk-0.1.0/a', tarfile.REGTYPE, b'a'), ('werk-0.1.0/a/b', tarfile.REGTYPE, b'b')])
        with self.assertRaises(ValueError):
            provision.extract_archive(archive, self.root / 'out', 'werk-0.1.0')
        previous = provision.MAX_RELEASE
        try:
            provision.MAX_RELEASE = 1
            with self.assertRaises(ValueError):
                provision.extract_archive(archive, self.root / 'out', 'werk-0.1.0')
        finally:
            provision.MAX_RELEASE = previous
        self.assertFalse((self.root / 'out').exists())

    def test_node_selects_only_regular_binary_and_license(self):
        prefix = 'node-v24.4.1-linux-x64'
        entries = [(prefix + '/bin/node', tarfile.REGTYPE, b'binary'), (prefix + '/LICENSE', tarfile.REGTYPE, b'license'), (prefix + '/bin/npm', tarfile.SYMTYPE, b'')]
        extracted = provision.extract_archive(self.archive(entries), self.root / 'out', prefix, node=True)
        self.assertTrue((extracted / 'bin/node').is_file())
        self.assertFalse((extracted / 'bin/npm').exists())
        self.assertEqual(sorted(str(path.relative_to(extracted)) for path in extracted.rglob('*') if path.is_file()), ['LICENSE', 'bin/node'])
        entries[0] = (prefix + '/bin/node', tarfile.SYMTYPE, b'')
        with self.assertRaises(ValueError):
            provision.extract_archive(self.archive(entries), self.root / 'bad', prefix, node=True)

    def test_never_merges_existing_destination(self):
        output = self.root / 'out'
        output.mkdir()
        (output / 'state').write_text('preserve')
        with self.assertRaises(ValueError):
            provision.extract_archive(self.archive([self.manifest()]), output, 'werk-0.1.0')
        self.assertEqual((output / 'state').read_text(), 'preserve')


class Readiness(unittest.TestCase):
    def test_stopped_is_not_ready_and_healthy_running_is(self):
        states = iter([{'ok': True, 'state': 'stopped'}, {'ok': True, 'state': 'running'}])
        calls = []
        def run(command, **options):
            calls.append(command)
            return type('Result', (), {'returncode': 0, 'stdout': json.dumps(next(states))})()
        provision.await_ready(['doctor'], run=run, sleep=lambda _: None)
        self.assertEqual(len(calls), 2)

    def test_failure_has_bounded_deadline_and_no_payload_echo(self):
        elapsed = [0]
        def sleep(seconds):
            elapsed[0] += seconds
        def run(command, **options):
            return type('Result', (), {'returncode': 1, 'stdout': 'private-do-not-print'})()
        with self.assertRaisesRegex(RuntimeError, 'startup deadline') as raised:
            provision.await_ready(['doctor'], timeout=3, run=run, clock=lambda: elapsed[0], sleep=sleep)
        self.assertEqual(elapsed[0], 3)
        self.assertNotIn('private-do-not-print', str(raised.exception))


if __name__ == '__main__':
    unittest.main()
