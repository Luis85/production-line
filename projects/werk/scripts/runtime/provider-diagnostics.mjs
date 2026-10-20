#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';
import { prepareProcessRuntime } from '../../src/worker/dist/shared/process/launcher.js';
import { ProviderStatusChecks } from '../../src/worker/dist/worker/infrastructure/provider-status.js';

/** Read-only pilot evidence: no inference, credential-file access, or raw provider output. */
const { values } = parseArgs({ options: { provider: { type: 'string', default: 'claude-cli' }, executable: { type: 'string' }, 'authentication-mode': { type: 'string', default: 'cli-account' } } });
if (!['claude-cli', 'codex-cli', 'cursor-cli'].includes(values.provider) || !values.executable || !isAbsolute(values.executable) || values['authentication-mode'] !== 'cli-account') {
  console.error('Use --provider claude-cli|codex-cli|cursor-cli --executable <absolute CLI path> --authentication-mode cli-account. This diagnostic checks account mode without making model requests.');
  process.exitCode = 2;
} else {
  const checks = new ProviderStatusChecks();
  try {
    if (process.platform === 'win32') console.error('Preparing the trusted Windows command runtime with a bounded setup deadline; provider checks keep their separate five-second deadlines.');
    await prepareProcessRuntime(process.cwd(), new AbortController().signal);
    const status = await checks.check({ id: /** @type {'claude-cli'|'codex-cli'|'cursor-cli'} */ (values.provider), executable: values.executable, model: '', apiKey: '', authenticationMode: 'cli-account' });
    console.log(JSON.stringify({ schemaVersion: 1, platform: process.platform, architecture: process.arch, node: process.versions.node,
      checkKind: 'read_only_diagnostic', liveInferenceQualified: false, status }, null, 2));
    if (!status.available || status.authentication !== 'authenticated') process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ schemaVersion: 1, platform: process.platform, architecture: process.arch, node: process.versions.node,
      checkKind: 'read_only_diagnostic', liveInferenceQualified: false, status: null, error: 'Trusted command runtime preparation could not complete within its bound. No provider authentication was confirmed.' }, null, 2));
    process.exitCode = 1;
  } finally { await checks.close(); }
}
