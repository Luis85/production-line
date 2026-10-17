import test from 'node:test';
import assert from 'node:assert/strict';
import { containsSensitivePatchMaterial } from '../../src/worker/dist/worker/application/review-patch-policy.js';

test('all review publication paths share the existing sensitive-material refusal grammar', () => {
  const sensitive = [
    '-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN EC PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----', 'sk-' + 'a'.repeat(20),
    ...['p', 'o', 'u', 's', 'r'].map(kind => 'gh' + kind + '_' + 'a'.repeat(20)),
  ];
  for (const value of sensitive) assert.equal(containsSensitivePatchMaterial('+' + value + '\n'), true, value.slice(0, 30));
  for (const value of ['', '+ordinary source change\n', '-----BEGIN CERTIFICATE-----', 'sk-' + 'a'.repeat(19), 'ghp_' + 'a'.repeat(19), 'prefixsk-' + 'a'.repeat(20)])
    assert.equal(containsSensitivePatchMaterial(value), false, value.slice(0, 30));
});
