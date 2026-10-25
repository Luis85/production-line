import { localMergeMarkdown, localMergeProjection, validLocalMergeProjection } from '../../application/local-merge-markdown.js';
import { releaseMarkdown } from '../../application/release-markdown.js';
import { remotePublicationMarkdown } from '../../application/remote-publication-markdown.js';
import { join } from "node:path";
import { stringify } from "yaml";
import type {
  FeatureRecord,
  FeatureGateProjection,
} from "../../application/feature-requests.js";
import type {
  WorkerRequest,
  GateStage,
  GateEvaluation,
  RequestFinding,
} from "../../application/request-gates.js";
import { gateIdentifier } from "../../application/request-gates.js";
import { readBoundedFile, atomicWrite } from "../journal/files.js";
import { featureId } from "./document.js";
const phases = new Set([
  "readiness",
  "needs_rework",
  "ready",
  "running",
  "waiting_input",
  "escalated",
  "review",
  "done",
  "failed",
  "cancelled",
  "interrupted",
]);
const outcomes = new Set(["pass", "fail", "unknown", "not_evaluated"]);
export function validateFeatureGates(record: FeatureRecord) {
  const projection = record.gates;
  if (!projection) return;
  const base = `_gates/${record.id}/`;
  if (
    !featureId.test(record.id) ||
    !gateIdentifier(projection.requestId) ||
    !Number.isSafeInteger(projection.revision) ||
    projection.revision < 0 ||
    !Number.isSafeInteger(projection.inputRevision) ||
    projection.inputRevision < 1 ||
    !gateIdentifier(projection.policyId) ||
    !Number.isSafeInteger(projection.policyVersion) ||
    projection.policyVersion < 1 ||
    !/^[a-f0-9]{64}$/.test(projection.policyDigest) ||
    !phases.has(projection.phase) ||
    !outcomes.has(projection.ready) ||
    !outcomes.has(projection.done) ||
    projection.link !== base + "request.md" ||
    projection.questions !== base + "questions.md" ||
    projection.gaps !== base + "gaps.md"
  )
    throw Error("Invalid feature request gate projection.");
  if (projection.localMerge && !validLocalMergeProjection(projection.localMerge)) throw Error('Invalid main checkout integration projection.');
  const run = projection.delivery;
  if (run && (!gateIdentifier(run.runId) || [run.status, run.phase, run.reason].some(value => typeof value !== 'string' || value.length > 4000) || run.waitingFor !== null && typeof run.waitingFor !== 'string' || !Array.isArray(run.controls) || run.controls.some(value => typeof value !== 'string') || run.checkpoint && (typeof run.checkpoint.branch !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(run.checkpoint.candidateCommit)))) throw Error('Invalid delivery checkpoint projection.');
}
function currentEvaluation(
  request: WorkerRequest,
  stage: GateStage,
): GateEvaluation | undefined {
  return request.evaluations.findLast(
    (evaluation) =>
      evaluation.stage === stage &&
      evaluation.inputHash === request.inputHash &&
      evaluation.inputRevision === request.inputRevision &&
      evaluation.policyDigest === request.policyDigest &&
      (stage === "ready" ||
        evaluation.outputDigest === request.execution?.outputDigest),
  );
}
function outcome(evaluation?: GateEvaluation): FeatureGateProjection["ready"] {
  if (!evaluation) return "not_evaluated";
  if (evaluation.passed) return "pass";
  return evaluation.rules.some((rule) => rule.result === "unknown")
    ? "unknown"
    : "fail";
}
const tableText = (value: unknown) =>
  (value === null || value === undefined
    ? "Unknown"
    : typeof value === "string"
      ? value
      : JSON.stringify(value)
  )
    .replace(/[\r\n]/g, " ")
    .replace(/\|/g, "\\|");
function evaluationText(evaluation?: GateEvaluation) {
  if (!evaluation)
    return "Not evaluated for the current approved input and output.\n";
  return (
    `Evaluation ${evaluation.id} · ${evaluation.at} · ${evaluation.passed ? "passed" : "not passed"}\n\n| Rule | Fact | Expected | Observed | Result |\n| --- | --- | --- | --- | --- |\n` +
    evaluation.rules
      .map(
        (rule) =>
          `| ${tableText(rule.ruleId)} | ${tableText(rule.fact)} | ${tableText(rule.expected)} | ${tableText(rule.observed)} | ${rule.result} |`,
      )
      .join("\n") +
    "\n" + (evaluation.readiness ? `\n### Semantic readiness\n\n${evaluation.readiness.message}\n\n${evaluation.readiness.conditions.map(item => `- ${tableText(item.id)}: ${item.outcome} — ${tableText(item.reason)}`).join('\n')}\n\n${evaluation.readiness.assessment ? `Assessment: ${evaluation.readiness.assessment.id}; input hash: ${evaluation.readiness.assessment.inputHash}; evaluator: ${evaluation.readiness.assessment.evaluator.kind}/${evaluation.readiness.assessment.evaluator.id}.\n\n` : ''}${evaluation.readiness.proposals.map(item => `- ${tableText(item.id)} (${item.kind}, ${item.impact} impact): **${item.status}** — ${tableText(item.text)}${item.decision ? `; operator reason: ${tableText(item.decision.reason)}` : ''}`).join('\n')}\n\nProposals are not answers to blocking questions. Use a guarded readiness_decision command in the original request to adopt or reject a current proposal.\n` : '')
  );
}
function findingsText(findings: RequestFinding[]) {
  return findings.length
    ? findings
        .map(
          (finding) =>
            `## ${finding.kind} · ${finding.id}\n\nStatus: ${finding.status} · ${finding.blocking ? "blocking" : "advisory"} · source: ${finding.source}\n\n${finding.message}\n${finding.resolution ? "\nOperator resolution: " + finding.resolution.note + "\n" : ""}`,
        )
        .join("\n")
    : "No findings of this type are currently recorded. This does not prove that every request gate passed.\n";
}
async function writeChanged(path: string, content: string) {
  const previous = await readBoundedFile(path, 524288).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (previous !== content) await atomicWrite(path, content);
}
/** Human-readable companions are projections, never an admission or evidence input. */
export async function exportFeatureGates(
  directory: string,
  record: FeatureRecord,
  request: WorkerRequest,
  ensureDirectory: (path: string) => Promise<void>,
): Promise<FeatureGateProjection> {
  const base = `_gates/${record.id}/`,
    ready = currentEvaluation(request, "ready"),
    done = currentEvaluation(request, "done");
  const projection: FeatureGateProjection = {
    requestId: request.id,
    revision: request.revision,
    inputRevision: request.inputRevision,
    phase: request.phase,
    ...(request.lifecycle ? { lifecycle: request.lifecycle } : {}),
    policyId: request.policy.id,
    policyVersion: request.policy.version,
    policyDigest: request.policyDigest,
    ready: outcome(ready),
    done: outcome(done),
    link: base + "request.md",
    questions: base + "questions.md",
    gaps: base + "gaps.md",
  };
  if (request.delivery) {
    const run = request.delivery, checkpoint = run.checkpoints?.at(-1);
    projection.delivery = { runId: run.id, status: run.status, phase: run.phase, reason: run.decision.reason, waitingFor: run.decision.waitingFor, controls: [...run.allowedControls], ...(checkpoint ? { checkpoint: { branch: checkpoint.branch, candidateCommit: checkpoint.candidateCommit } } : {}) };
  }
  if (request.delivery?.localMerge) projection.localMerge = localMergeProjection(request.delivery.localMerge);
  if (request.delivery?.release) {
    const { merge, build, published, operations } = request.delivery.release;
    projection.release = { ...(merge ? { merge: structuredClone(merge) } : {}), ...(build ? { build: structuredClone(build) } : {}), ...(published ? { published: structuredClone(published) } : {}),
      operations: operations.map(({ operationId, action, status, detail }) => ({ operationId, action, status, detail })) };
  }
  if (request.delivery?.publications?.length) projection.publications = structuredClone(request.delivery.publications);
  validateFeatureGates({ ...record, gates: projection });
  const root = join(directory, "_gates", record.id);
  await ensureDirectory(root);
  const metadata =
    "---\n" +
    stringify({
      schemaVersion: 1,
      featureId: record.id,
      sessionId: record.sessionId,
      ...projection,
      capturedAt: request.updatedAt,
    }) +
    "---\n";
  const note =
    "Generated from the authoritative worker request. This projection can become stale; read current request state and its revision before acting. Editing this file or the original feature metadata cannot answer a question, satisfy a gate or admit another execution. The original accepted Markdown body remains unchanged.\n";
  const main =
    metadata +
    "# Request gate checkpoint\n\n" +
    note +
    `\nRequest phase: ${request.phase}\nModel execution outcome: ${request.execution?.outcome ?? "not recorded"}\nRework owner: ${request.assignee}\n\n## Ready gate\n\n` +
    evaluationText(ready) +
    (projection.delivery ? `\n## Delivery run\n\nRun ID: ${projection.delivery.runId}\nStatus: ${projection.delivery.status}\nPhase: ${projection.delivery.phase}\nReason: ${projection.delivery.reason}\nWaiting for: ${projection.delivery.waitingFor ?? 'No external event'}\nAvailable controls: ${projection.delivery.controls.join(', ') || 'None'}\n` + (projection.delivery.checkpoint ? `\nInspectable checkpoint (not a verification pass): ${projection.delivery.checkpoint.candidateCommit} on ${projection.delivery.checkpoint.branch}\n` : '') : '') +
    (projection.localMerge ? "\n" + localMergeMarkdown(projection.localMerge) + "\n" : "") +
    (projection.release ? "\n" + releaseMarkdown(projection.release) + "\n" : "") +
    (projection.publications?.length ? "\n" + remotePublicationMarkdown(projection.publications) + "\n" : "") +
    "\n## Done gate\n\n" +
    evaluationText(done) +
    "\n## Questions, issues and gaps\n\n" +
    findingsText(request.findings) +
    "\n## Current approved input\n\n" +
    request.input.message +
    "\n\nThe original intake body is retained separately. Candidate input revisions require an explicit guarded acceptance; a companion edit is not an acceptance.\n\n## Frozen policy\n\n```json\n" +
    JSON.stringify(request.policy, null, 2) +
    "\n```\n";
  await writeChanged(join(root, "request.md"), main);
  await writeChanged(
    join(root, "questions.md"),
    metadata +
      "# Request question checkpoint\n\n" +
      note +
      "\n" +
      findingsText(
        request.findings.filter((finding) => finding.kind === "question"),
      ),
  );
  await writeChanged(
    join(root, "gaps.md"),
    metadata +
      "# Request gaps and issues checkpoint\n\n" +
      note +
      "\n" +
      findingsText(
        request.findings.filter((finding) => finding.kind !== "question"),
      ),
  );
  return projection;
}
