import test from 'node:test';
import assert from 'node:assert/strict';
import { testErrorCode } from '../helpers/typed-boundaries.mjs';
import { advisoryResult } from '../../src/worker/dist/worker/application/request-review-protocol.js';
import { reviewerInput as input, valid } from './request-review-fixtures.mjs';

test("strict advisory schema forbids authority, approved-file changes and unbounded output", () => {
  const parsed = advisoryResult({ type: "completed", text: valid }, input, "ready", "review");
  assert.equal(parsed.findings[0].blocking, true);
  assert.equal(parsed.candidate.message, "Revised request text");
  for (const key of ["kind", "title", "criteria", "files", "context"])
    assert.deepEqual(parsed.candidate[key], input[key]);
  assert.equal(input.message, "Original request");
  const candidates = [
    { schemaVersion: 1, findings: [], facts: { "tests.passed": true } },
    { schemaVersion: 1, findings: [], attestation: true },
    { schemaVersion: 1, findings: [], policy: {} },
    {
      schemaVersion: 1,
      findings: [],
      candidate: { message: "Changed", files: [] },
    },
    {
      schemaVersion: 1,
      findings: [{ kind: "gap", message: "", blocking: true }],
    },
    {
      schemaVersion: 1,
      findings: [{ kind: "gap", message: "Fine", blocking: "false" }],
    },
    {
      schemaVersion: 1,
      findings: Array.from({ length: 33 }, () => ({
        kind: "gap",
        message: "Fine",
        blocking: false,
      })),
    },
    {
      schemaVersion: 1,
      findings: [{ kind: "gap", message: "x".repeat(4001), blocking: true }],
    },
  ];
  for (const candidate of candidates)
    assert.throws(
      () => advisoryResult({ type: "completed", text: JSON.stringify(candidate) }, input, "ready", "review"),
      (error) => testErrorCode(error) === "protocol",
    );
  assert.throws(
    () => advisoryResult({ type: "completed", text: "Arbitrary prose" }, input, "ready", "review"),
    (error) => testErrorCode(error) === "protocol",
  );
  assert.throws(
    () => advisoryResult({ type: "completed", text: "x".repeat(262145) }, input, "ready", "review"),
    (error) => testErrorCode(error) === "protocol",
  );
});
