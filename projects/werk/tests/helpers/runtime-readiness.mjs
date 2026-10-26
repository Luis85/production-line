const lifecycleEvents = new Set(['starting', 'ready', 'stopping', 'stopped', 'child_exited']);
const stages = new Set(['setup', 'starting', 'running', 'stopping', 'stopped']);
const roles = new Set(['factory', 'line', 'worker', 'orchestrator']);
const fixtureIds = new Set(['root', 'alpha']);
const errorCodes = new Set(['EADDRINUSE', 'EACCES', 'ENOENT', 'EPERM', 'ETIMEDOUT', 'EBUSY', 'invalid_input', 'unavailable', 'conflict', 'internal_error', 'unauthorized', 'not_found', 'forbidden']);
function diagnostic(owner) {
  const events = [];
  for (const line of owner.output.split('\n')) {
    let value; try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== 'object') continue;
    const entry = {};
    if (lifecycleEvents.has(value.event)) entry.event = value.event;
    if (stages.has(value.state)) entry.stage = value.state;
    if (roles.has(value.role)) entry.role = value.role;
    if (fixtureIds.has(value.id)) entry.id = value.id;
    if (Number.isSafeInteger(value.exitCode)) entry.exitCode = value.exitCode;
    if (errorCodes.has(value.error?.code)) entry.errorCode = value.error.code;
    if (Object.keys(entry).length) events.push(entry);
  }
  return { exitCode: owner.child.exitCode, stdoutBytes: Buffer.byteLength(owner.output), stderrBytes: Buffer.byteLength(owner.errors), events: events.slice(-16) };
}
/** @param {() => unknown | Promise<unknown>} check @param {string} label
 * @param {{child: import('node:child_process').ChildProcess, readonly output: string, readonly errors: string}} [owner] */
export async function waitForRuntimeReadiness(check, label, owner) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (owner && (owner.child.exitCode !== null || owner.child.signalCode !== null)) throw Error('Runtime exited before ' + label + ': ' + JSON.stringify(diagnostic(owner)));
    const result = await check(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error('Timed out: ' + label + (owner ? ': ' + JSON.stringify(diagnostic(owner)) : ''));
}
