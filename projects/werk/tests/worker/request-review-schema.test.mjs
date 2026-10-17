import test from 'node:test';
import assert from 'node:assert/strict';
import { testErrorCode } from '../helpers/typed-boundaries.mjs';
import { parseAdvisoryReview } from '../../src/worker/dist/worker/application/request-review.js';
import { input, valid } from './request-review-fixtures.mjs';

test("strict advisory schema forbids authority, approved-file changes and unbounded output", () => {
  const parsed = parseAdvisoryReview(valid, input, "ready");
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
      () => parseAdvisoryReview(JSON.stringify(candidate), input, "ready"),
      (error) => testErrorCode(error) === "protocol",
    );
  assert.throws(
    () => parseAdvisoryReview("Arbitrary prose", input, "ready"),
    (error) => testErrorCode(error) === "protocol",
  );
  assert.throws(
    () => parseAdvisoryReview("x".repeat(262145), input, "ready"),
    (error) => testErrorCode(error) === "protocol",
  );
});
