import { before } from 'node:test';
import { prepareProcessRuntime } from '../../src/worker/dist/shared/process/launcher.js';

/** Register native setup before bounded scenarios; POSIX preparation performs no work. */
export function prepareNativeProcessFixture() {
  // Trusted setup owns 45 seconds; the hook allows another five seconds for cancellation to drain.
  before(async context => prepareProcessRuntime(process.cwd(), context.signal), { timeout: 50000 });
}
