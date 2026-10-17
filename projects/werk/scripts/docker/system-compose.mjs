import { createHash } from 'node:crypto';
import { join } from 'node:path';
// Docker Compose interpolates dollar signs even in JSON; escape literal host values.
const literal = value => String(value).replaceAll('$', () => '$$');
export function systemProject(definition, identity) {
  return 'werk-system-' + createHash('sha256').update(definition.id + '\0' + identity).digest('hex').slice(0, 16);
}
/** @param {ReturnType<typeof import('../system/definition.mjs').validateDefinition>} definition @param {{hostState: string, image: string, uid?: string, gid?: string, volume?: string}} options */
export function composeSystem(definition, { hostState, image, uid = '1000', gid = '1000', volume }) {
  if (definition.environment !== 'docker') throw Error('Docker launcher requires environment docker');
  const mount = (relative, target, readOnly = false) => volume
    ? { type: 'volume', source: 'system-state', target, read_only: readOnly, volume: relative ? { subpath: relative } : {} }
    : { type: 'bind', source: literal(join(hostState, relative)), target, read_only: readOnly, bind: { create_host_path: false } };
  const base = (role, index) => ({ image: literal(image), user: `${uid}:${gid}`, init: true, restart: 'unless-stopped', read_only: true,
    environment: {'WERK_ALERT_QUEUE_AGE_SECONDS': '${WERK_ALERT_QUEUE_AGE_SECONDS:-300}', 'WERK_ALERT_FAILURE_WINDOW_SECONDS': '${WERK_ALERT_FAILURE_WINDOW_SECONDS:-900}', 'WERK_ALERT_FAILED_ATTEMPTS': '${WERK_ALERT_FAILED_ATTEMPTS:-3}', 'WERK_ALERT_OUTBOX_AGE_SECONDS': '${WERK_ALERT_OUTBOX_AGE_SECONDS:-120}', 'WERK_ALERT_OUTBOX_PENDING': '${WERK_ALERT_OUTBOX_PENDING:-100}', 'WERK_ALERT_STALE_OBSERVATION_SECONDS': '${WERK_ALERT_STALE_OBSERVATION_SECONDS:-120}'},
    logging: { driver: 'local', options: { 'max-size': '1m', 'max-file': '2' } },
    tmpfs: ['/tmp'], cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], stop_grace_period: '20s',
    entrypoint: ['node', '/app/scripts/docker/system-service.mjs', role, ...(index === undefined ? [] : [String(index)])] });
  const health = (port, path, worker = false) => ({ test: ['CMD', 'node', '-e', `fetch('http://127.0.0.1:${port}${path}',{signal:AbortSignal.timeout(2000)}).then(async r=>{if(!r.ok)throw Error();${worker ? "const s=await r.json();if(!['idle','executing'].includes(s.state))throw Error();" : ''}}).catch(()=>process.exit(1))`], interval: '2s', timeout: '3s', retries: 30, start_period: '3s' });
  const factory = { ...base('factory'), ports: [`127.0.0.1:${definition.factory.port}:3100`],
    volumes: [mount('factory-input', '/state', true), mount('factory', '/state/factory')], healthcheck: health(3100, '/healthz') };
  const services = { factory };
  definition.productionLines.forEach((line, i) => {
    const name = `line-${i + 1}`, directory = `lines/${line.id}`;
    services[name] = { ...base('orchestrator'), volumes: [mount(directory, '/state')], ports: [`127.0.0.1:${line.orchestrator.port}:3000`], healthcheck: health(3000, '/healthz') };
    for (let n = 1; n <= line.workers.count; n++) services[`${name}-worker-${n}`] = { ...base('worker'),
      volumes: [mount(`${directory}/workers/worker-${n}`, '/state')], ports: [`127.0.0.1:${line.workers.statusPort + n - 1}:4100`],
      depends_on: { [name]: { condition: 'service_healthy' } }, healthcheck: health(4100, '/status', true) };
  });
  return { services, ...(volume ? { volumes: { 'system-state': { external: true, name: literal(volume) } } } : {}) };
}
