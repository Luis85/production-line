import { cleanup } from './fixture-cleanup.mjs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerRequestJournal } from '../../src/worker/dist/worker/infrastructure/journal/requests.js';
import { prepareModelRequest } from '../../src/worker/dist/worker/application/model-contract.js';

export const provider = {
  id: "fixture",
  model: "fixture-v1",
  instruction: "No external calls.",
};
/** @type {import('../../src/worker/application/request-gates.js').GateInput} */
export const input = {
  kind: "chat",
  title: "Clarify retry semantics",
  message: "Explain retry behavior.",
};
export async function fixture(t) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "werk-gates-")),
  );
  const journal = new WorkerRequestJournal(directory);
  await journal.init();
  cleanup(t, async () => {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, journal };
}
export function admit(journal, patch = {}, key = "root") {
  return journal.ensure({
    owner: { sessionId: "session", rootTurnId: key },
    provider,
    input: { ...input, ...patch },
  });
}
export function execute(
  journal,
  request,
  result = { type: "completed", text: "Known answer." },
  facts = {},
) {
  journal.evaluate(request.id, "ready");
  journal.bindTurn(request.id, "turn");
  journal.prepareExecution(request.id, "turn", "run");
  journal.startExecution(request.id, "turn", "run");
  return journal.recordResult(request.id, "turn", "run", result, facts);
}
export function command(journal, request, action, rest = {}) {
  return journal.command({
    action,
    requestId: request.id,
    expectedRevision: request.revision,
    operationId: "op-" + action,
    ...rest,
  });
}
export const dispatch = () => {
  const model = {
      configuration: provider,
      async reply() {
        throw Error("No provider call in tests");
      },
    };
  return prepareModelRequest(model, [
      {
        id: "review",
        role: "user",
        state: "complete",
        text: "Review only.",
        at: new Date().toISOString(),
      },
    ],
  );
};
