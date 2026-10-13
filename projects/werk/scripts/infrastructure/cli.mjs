import { assertNode } from '../runtime/config.mjs';
import { prepare, render } from './cloud-init.mjs';

const usage = 'node werk.mjs infrastructure validate|render --file PATH --release-version VERSION --release-url HTTPS_URL --release-sha256 HEX --node-url HTTPS_URL --node-sha256 HEX --architecture x86_64|arm64 [--json]\nUbuntu 24.04 only. Native YAML, ports >=1024, exact versioned Werk tar.gz and official Node 24 tar.xz are required.\nRead-only: validate emits a JSON plan; render emits cloud-config (or a JSON result with --json). No network or state writes. No secrets accepted inline.';
export function parse(args) {
  const remaining = [...args], command = remaining.shift() ?? 'help', options = {};
  if (['help', '-h', '--help'].includes(command)) { if (remaining.length) throw Error('Help does not accept additional arguments.'); return { command: 'help', options }; }
  if (!['validate', 'render'].includes(command)) throw Error('Expected infrastructure validate or render.');
  const allowed = ['file', 'release-version', 'release-url', 'release-sha256', 'node-url', 'node-sha256', 'architecture', 'json'];
  while (remaining.length) {
    const flag = remaining.shift();
    if (!flag.startsWith('--') || !allowed.includes(flag.slice(2)) || Object.hasOwn(options, flag.slice(2))) throw Error('Unknown or repeated infrastructure option.');
    const key = flag.slice(2);
    if (key === 'json') options[key] = true;
    else { const value = remaining.shift(); if (!value || value.startsWith('--')) throw Error('Infrastructure option requires a value.'); options[key] = value; }
  }
  return { command, options };
}
export async function main(args, { stdout = value => console.log(value), stderr = value => console.error(value) } = {}) {
  try {
    assertNode(); const { command, options } = parse(args);
    if (command === 'help') { stdout(usage); return 0; }
    const prepared = await prepare(options);
    if (command === 'validate') stdout(JSON.stringify({ ok: true, profile: prepared.artifacts.profile, plan: prepared.plan }));
    else { const result = await render(prepared); stdout(options.json ? JSON.stringify(result) : result.cloudConfig); }
    return 0;
  } catch (error) {
    const message = error.code === 'INVALID_INFRASTRUCTURE_INPUT' || error.code === 'INVALID_SYSTEM_DEFINITION' || !error.code ? error.message : 'Cannot read the system definition or infrastructure profile assets.';
    if (args.includes('--json')) stdout(JSON.stringify({ ok: false, error: { code: 'INVALID_INFRASTRUCTURE_INPUT', message } }));
    else stderr(message);
    return 2;
  }
}
