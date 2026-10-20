import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { candidateGitTree } from '../../src/worker/dist/worker/infrastructure/candidate-git-tree.js';
import { cleanup } from './fixture-cleanup.mjs';

for (const format of ['sha1', 'sha256']) {
  test(`raw candidate tree matches Git ${format} for nested paths, binary blobs and executable modes`, async t => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'werk-tree-proof-')));
    cleanup(t, () => rm(directory, { recursive: true, force: true }));
    /** @param {string[]} args @param {Buffer | undefined} [input] */
    const git = (args, input = undefined) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    git(['init', `--object-format=${format}`]);
    const proof = candidateGitTree(format);
    /** @type {[string, Buffer, boolean][]} */
    const files = [
      ['a', Buffer.from('a\r\n'), false], ['a.c', Buffer.from(''), false], ['a0', Buffer.from('zero'), false],
      ['a.dir/nested/name', Buffer.from('nested\n'), false], ['a.dir/file', Buffer.from('branch\n'), false],
      ['ä.txt', Buffer.from('Unicode\n'), false], ['z.bin', Buffer.from([0, 255, 128, 10]), false],
      ['script.mjs', Buffer.from('#!/usr/bin/env node\n'), true],
    ];
    for (const [path, bytes, executable] of files) {
      const blob = git(['hash-object', '-w', '--stdin', '--no-filters'], bytes);
      git(['update-index', '--add', '--cacheinfo', executable ? '100755' : '100644', blob, path]);
      proof.add(path, bytes, executable);
    }
    assert.equal(proof.digest(), git(['write-tree']));
    assert.equal(proof.digest(), proof.digest(), 'proof inspection is stable and does not mutate the tree');
    assert.throws(() => proof.add('a', Buffer.from('duplicate'), false), /duplicate/);
    assert.throws(() => proof.add('a/child', Buffer.from('conflict'), false), /conflicting/);
  });
}
