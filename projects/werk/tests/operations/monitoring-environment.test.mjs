import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeEnvironment } from '../../scripts/runtime/supervisor.mjs';
test('native child environment forwards bounded alert settings without forwarding arbitrary Werk secrets', () => {
  const source = { PATH: '/bin', WERK_ALERT_QUEUE_AGE_SECONDS: '42', WERK_ALERT_OUTBOX_PENDING: '100', WERK_ADMIN_TOKEN: 'secret', WERK_ALERT_SECRET: 'secret', NODE_OPTIONS: '--inspect' };
  assert.deepEqual(runtimeEnvironment(source), { PATH: '/bin', WERK_ALERT_QUEUE_AGE_SECONDS: '42', WERK_ALERT_OUTBOX_PENDING: '100' });
  for (const value of ['0', '-1', '1.5', 'SECRET_CONFIG', '8640001', '01']) assert.throws(() => runtimeEnvironment({ WERK_ALERT_QUEUE_AGE_SECONDS: value }), error => !error.message.includes('SECRET_CONFIG'));
});

test('provider context is opt-in and never forwards application secrets or Node injection options', () => {
  const source = { PATH: '/bin', CODEX_HOME: '/private/provider', CODEX_EXEC_SERVER_REMOTE_BASE_URL: 'https://policy.invalid', HTTPS_PROXY: 'http://proxy.invalid', NODE_EXTRA_CA_CERTS: '/trust.pem', WERK_ADMIN_TOKEN: 'private-admin', WERK_ENROLLMENT_TOKEN: 'private-enrollment', NODE_OPTIONS: '--require=/evil.js', UNRELATED_SECRET: 'private-other' };
  assert.deepEqual(runtimeEnvironment(source), { PATH: '/bin' });
  assert.deepEqual(runtimeEnvironment(source, { liveProvider: true }), { PATH: '/bin', CODEX_HOME: '/private/provider', CODEX_EXEC_SERVER_REMOTE_BASE_URL: 'https://policy.invalid', HTTPS_PROXY: 'http://proxy.invalid', NODE_EXTRA_CA_CERTS: '/trust.pem' });
});
