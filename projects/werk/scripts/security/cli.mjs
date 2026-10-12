import { assertNode, inputError } from '../runtime/config.mjs';
import { accessCommand } from './access.mjs';
import { ingressProfile } from './ingress.mjs';
const help = `Werk security operations
node werk.mjs security access list --state-dir SERVICE_STATE [--json]
node werk.mjs security access grant --state-dir SERVICE_STATE --id NAME --role operator|viewer [--json]
node werk.mjs security access rotate|revoke --state-dir SERVICE_STATE --id NAME [--json]
node werk.mjs security access rollback --state-dir SERVICE_STATE [--json]
node werk.mjs security ingress --hostname werk.example.com --port 3100 [--json]

SERVICE_STATE is .werk, system-state/factory or system-state/lines/LINE_ID.
Generated tokens stay in private access.json. Changes require an owning runtime restart.
Legacy admin credentials are preserved; rollback restores the previous named credential set.
Ingress prints a Caddy configuration for an already-loopback-bound service; it does not install or expose anything.
`;
export async function main(args = process.argv.slice(2), { stdout = value => console.log(value), stderr = value => console.error(value) } = {}) {
  let json = args.includes('--json');
  try {
    assertNode(); args = [...args]; const scope = args.shift() ?? 'help';
    if (['help', '--help'].includes(scope)) { stdout(help); return 0; }
    const action = scope === 'access' ? args.shift() : undefined;
    const allowed = scope === 'ingress' ? ['hostname', 'port', 'json'] : scope === 'access' && ['list', 'grant', 'rotate', 'revoke', 'rollback'].includes(action) ? ['state-dir', 'json', ...(['grant', 'rotate', 'revoke'].includes(action) ? ['id'] : []), ...(action === 'grant' ? ['role'] : [])] : [];
    if (!allowed.length) throw inputError('Unknown security command. Run node werk.mjs security --help.');
    const options = {};
    while (args.length) {
      const option = args.shift(); const key = option.slice(2);
      if (!option.startsWith('--') || !allowed.includes(key) || Object.hasOwn(options, key)) throw inputError('Unknown or repeated security option.');
      if (key === 'json') options[key] = true;
      else { const value = args.shift(); if (!value || value.startsWith('--')) throw inputError('Security option requires a value.'); options[key] = value; }
    }
    let result;
    if (scope === 'ingress') { if (!/^[1-9][0-9]*$/.test(options.port ?? '')) throw inputError('--port requires an integer.'); result = { ok: true, format: 'Caddyfile', config: ingressProfile({ hostname: options.hostname, port: Number(options.port) }) }; }
    else result = await accessCommand(action, { stateDir: options['state-dir'], id: options.id, role: options.role });
    stdout(scope === 'ingress' && !json ? result.config : JSON.stringify(result)); return 0;
  } catch (error) {
    const result = { ok: false, error: { code: 'SECURITY_CONFIGURATION_FAILED', message: error instanceof Error ? error.message : 'Security operation failed' } };
    if (json) stdout(JSON.stringify(result)); else stderr(result.error.message); return error.exitCode === 2 || error.code === 'invalid_input' ? 2 : 1;
  }
}
