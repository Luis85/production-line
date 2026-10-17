import { withOwnedResponse } from '../../shared/http/transport.js';
import { readResponseBody, ResponseBodyLimitError } from '../../shared/http/response-body.js';
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
    return withOwnedResponse(new URL(item.deliveryPath ?? '/v1/tasks', line.orchestratorUrl), {
      method: 'POST', redirect: 'error', signal: this.abort.signal,
      headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json', 'idempotency-key': 'factory:' + item.id }, body: JSON.stringify(task),
    }, 10000, async response => {
      if (!response.ok) { await response.body?.cancel(); throw Error('Delivery not acknowledged'); }
      if (!response.body) throw Error('Empty acknowledgement');
      let bytes: Uint8Array;
      try { bytes = await readResponseBody(response.body, 65536); }
      catch (error) {
        if (error instanceof ResponseBodyLimitError) throw Error('Oversized acknowledgement');
        throw error;
      }
      const result = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (result.project !== item.task.project) throw Error('Wrong project acknowledgement');
      return identifier(result.id, 'taskId');
    });
  }
}
