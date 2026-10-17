import { testErrorMessage } from '../helpers/typed-boundaries.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeEnvironment } from '../../scripts/runtime/supervisor.mjs';
test('native child environment forwards bounded alert settings without forwarding arbitrary Werk secrets', () => {
  const source = { PATH: '/bin', WERK_ALERT_QUEUE_AGE_SECONDS: '42', WERK_ALERT_OUTBOX_PENDING: '100', WERK_ADMIN_TOKEN: 'secret', WERK_ALERT_SECRET: 'secret', NODE_OPTIONS: '--inspect' };
  assert.deepEqual(runtimeEnvironment(source), { PATH: '/bin', WERK_ALERT_QUEUE_AGE_SECONDS: '42', WERK_ALERT_OUTBOX_PENDING: '100' });
  for (const value of ['0', '-1', '1.5', 'SECRET_CONFIG', '8640001', '01']) assert.throws(() => runtimeEnvironment({ WERK_ALERT_QUEUE_AGE_SECONDS: value }), error => !testErrorMessage(error).includes('SECRET_CONFIG'));
});

test('worker Git context survives both supervisor hops without provider secrets or Git command injection', () => {
  const source = { PATH: '/bin', HTTPS_PROXY: 'http://proxy.invalid', https_proxy: 'http://proxy.invalid', NO_PROXY: 'localhost', SSL_CERT_FILE: '/trust.pem', NODE_EXTRA_CA_CERTS: '/trust.pem', SSH_AUTH_SOCK: '/agent.sock', GIT_SSL_CAINFO: '/git-trust.pem', GIT_SSL_CAPATH: '/git-trust', CODEX_HOME: '/private/provider', OPENAI_API_KEY: 'private-provider', WERK_ADMIN_TOKEN: 'private-admin', GIT_SSH_COMMAND: 'unapproved-command', GIT_CONFIG_COUNT: '1', NODE_OPTIONS: '--require=/evil.js' };
  const expected = { PATH: '/bin', HTTPS_PROXY: 'http://proxy.invalid', https_proxy: 'http://proxy.invalid', NO_PROXY: 'localhost', SSL_CERT_FILE: '/trust.pem', NODE_EXTRA_CA_CERTS: '/trust.pem', SSH_AUTH_SOCK: '/agent.sock', GIT_SSL_CAINFO: '/git-trust.pem', GIT_SSL_CAPATH: '/git-trust' };
  const line = runtimeEnvironment(source, { gitAccess: true });
  assert.deepEqual(line, expected);
  assert.deepEqual(runtimeEnvironment(line, { gitAccess: true }), expected);
  assert.deepEqual(runtimeEnvironment(line), { PATH: '/bin' });
});

test('provider context is opt-in and never forwards application secrets or Node injection options', () => {
  const source = { PATH: '/bin', CODEX_HOME: '/private/provider', CODEX_EXEC_SERVER_REMOTE_BASE_URL: 'https://policy.invalid', HTTPS_PROXY: 'http://proxy.invalid', NODE_EXTRA_CA_CERTS: '/trust.pem', WERK_ADMIN_TOKEN: 'private-admin', WERK_ENROLLMENT_TOKEN: 'private-enrollment', NODE_OPTIONS: '--require=/evil.js', UNRELATED_SECRET: 'private-other' };
  assert.deepEqual(runtimeEnvironment(source), { PATH: '/bin' });
  assert.deepEqual(runtimeEnvironment(source, { liveProvider: true }), { PATH: '/bin', CODEX_HOME: '/private/provider', CODEX_EXEC_SERVER_REMOTE_BASE_URL: 'https://policy.invalid', HTTPS_PROXY: 'http://proxy.invalid', NODE_EXTRA_CA_CERTS: '/trust.pem' });
});
