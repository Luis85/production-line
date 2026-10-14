import { identifier } from '../../shared/contracts.js';
import type { ProductionLine } from '../../shared/factory.js';
import type { IntakeTask, LineDelivery } from '../application/intake.js';
export class HttpLineDelivery implements LineDelivery {
  private readonly credentials: Readonly<Record<string, string>>;
  private readonly abort = new AbortController();
  constructor(credentials: Readonly<Record<string, string>>) { this.credentials = credentials; }
  close() { this.abort.abort(); }
  async send(line: ProductionLine, item: IntakeTask): Promise<string> {
    const credential = this.credentials[line.tokenEnv];
    if (!credential) throw Error('Line credential unavailable');
    const task = item.deliveryTask ?? item.task;
    const response = await fetch(new URL(item.deliveryPath ?? '/v1/tasks', line.orchestratorUrl), {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)]),
      headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json', 'idempotency-key': 'factory:' + item.id }, body: JSON.stringify(task),
    });
    if (!response.ok) { await response.body?.cancel(); throw Error('Delivery not acknowledged'); }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
    if (!reader) throw Error('Empty acknowledgement');
    try {
      for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > 65536) { await reader.cancel(); throw Error('Oversized acknowledgement'); } chunks.push(result.value); }
    } finally { reader.releaseLock(); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (result.project !== item.task.project) throw Error('Wrong project acknowledgement');
    return identifier(result.id, 'taskId');
  }
}
