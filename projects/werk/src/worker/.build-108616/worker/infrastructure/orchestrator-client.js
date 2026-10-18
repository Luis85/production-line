import { profiles as validateProfiles } from '../../shared/contracts.js';
import { validateRequestGateEvidence } from "../../shared/request-gate.js";
                                                                             
                                                          
import { ApiError } from "../../shared/http/errors.js";
import { ReportingError } from "../application/errors.js";
import { verifyPinnedContext } from "./context.js";
import { request } from "../../shared/http/client.js";
import {
  responseRecord as record,
  assignmentResponse as assignment,
  acknowledgeSnapshot,
  acknowledgeCompletion,
  acknowledgeAbandonment,
  contextIdentity,
} from "./responses.js";
             
               
                
                 
                                 

/** Injectable transport keeps protocol mapping independently testable. */
                             
               
               
                
                  
                 
                      

/** HTTP details and credential use stop at this adapter boundary. */
export class HttpWorkerGateway                          {
          base        ;
          enrollmentToken        ;
          transport               ;

  constructor(
    base        ,
    enrollmentToken        ,
    transport                = request,
  ) {
    this.base = base;
    this.enrollmentToken = enrollmentToken;
    this.transport = transport;
  }

          async send(
    path        ,
    token        ,
    method        ,
    body          ,
  )                   {
    try {
      return await this.transport(this.base, path, token, method, body);
    } catch (error) {
      // A remote response or transport exception may echo credentials or private source.
      // Keep retry semantics, but never carry that diagnostic into worker status or evidence.
      if (error instanceof ApiError)
        throw new ReportingError(
          `Orchestrator request failed (HTTP ${error.status})`,
          retryableTransportError(error),
        );
      throw new ReportingError("Orchestrator transport request failed", true);
    }
  }

  async register(profiles           , policy              ) {
    const value = record(
      await this.send("/v1/workers/register", this.enrollmentToken, "POST", {
        profiles,
        policy,
      }),
    );
    if (
      ![value.id, value.token, value.project].every(
        (field) => typeof field === "string" && field.length > 0,
      )
    ) {
      throw Error("Invalid orchestrator registration");
    }
    return {
      id: value.id          ,
      token: value.token          ,
      project: value.project          ,
    };
  }

  connect(identity                               )               {
    const call = (path        , method = "POST", body          ) =>
      this.send(path, identity.token, method, body);
    const leaseBody = (task                                        ) => ({
      lease: task.lease,
      attempt: task.attempt,
    });
    const taskPath = (task                  , action        ) =>
      `/v1/worker/tasks/${encodeURIComponent(task.id)}/${action}`;
    return {
      async updateProfiles(input) {
        const response = record(await call('/v1/worker/profiles', 'POST', input));
        const profiles = validateProfiles(response.profiles);
        if (response.configurationHash !== input.configurationHash || JSON.stringify(profiles) !== JSON.stringify(input.profiles))
          throw new Error('Orchestrator acknowledged different execution profiles');
        return { profiles, configurationHash: input.configurationHash };
      },
      async currentAssignments() {
        const response = record(
          await call("/v1/worker/assignments/current", "GET"),
        );
        if (!Array.isArray(response.tasks))
          throw Error("Invalid orchestrator assignments response");
        return response.tasks.map(assignment);
      },
      async claim(requestId        , queueCapacity         , repositoryIds           , legacyRepository          ) {
        const response = record(
          await call("/v1/worker/assignments/next", "POST", {
            requestId,
            ...(queueCapacity === undefined ? {} : { queueCapacity }),
            ...(repositoryIds === undefined ? {} : { repositoryIds, legacyRepository: legacyRepository ?? false }),
          }),
        );
        return response.task === null ? null : assignment(response.task);
      },
      async heartbeat(task      ) {
        const updated = assignment(
          await call(taskPath(task, "heartbeat"), "POST", leaseBody(task)),
        );
        if (
          updated.id !== task.id ||
          updated.lease !== task.lease ||
          updated.attempt !== task.attempt ||
          updated.workerId !== task.workerId ||
          updated.project !== task.project ||
          updated.repository !== task.repository ||
          updated.profile !== task.profile ||
          contextIdentity(updated.context) !== contextIdentity(task.context)
        ) {
          throw Error("Orchestrator renewed a different assignment");
        }
        return updated;
      },
      async verifyContext(task      ) {
        const query =
          "?lease=" +
          encodeURIComponent(task.lease ?? "") +
          "&attempt=" +
          encodeURIComponent(task.attempt);
        const manifest = await call(taskPath(task, "context") + query, "GET");
        verifyPinnedContext(manifest, task);
      },
      async publishSnapshot(snapshot          ) {
        acknowledgeSnapshot(
          await call("/v1/worker/snapshots", "POST", snapshot),
          snapshot,
        );
      },
      async complete(task      ) {
        acknowledgeCompletion(
          await call(taskPath(task, "complete"), "POST", leaseBody(task)),
          task,
        );
      },
      async resolveHold(task, heldEvaluationId, gate) {
        const result = record(
          await call(taskPath(task, "resolve-hold"), "POST", {
            ...leaseBody(task),
            heldEvaluationId,
            gate,
          }),
        );
        if (
          result.id !== task.id ||
          result.attempt !== task.attempt ||
          !["review", "simulated"].includes(String(result.status))
        )
          throw Error("Invalid gate resolution acknowledgement");
        const receipt = validateRequestGateEvidence(result.requestGate);
        for (const key of [
          "requestId",
          "inputDigest",
          "policyDigest",
          "evaluationId",
          "stage",
          "status",
          "failedRules",
          "unknownRules",
        ]         )
          if (receipt[key] !== gate[key])
            throw Error(
              "Gate resolution acknowledgement differs from the accepted decision",
            );
      },
      async hold(task, gate) {
        const result = record(
          await call(taskPath(task, "hold"), "POST", {
            ...leaseBody(task),
            gate,
          }),
        );
        if (result.id !== task.id || result.status !== "blocked")
          throw Error("Invalid gate hold acknowledgement");
      },
      async abandon(task      ) {
        acknowledgeAbandonment(
          await call(taskPath(task, "abandon"), "POST", leaseBody(task)),
          task,
        );
      },
    };
  }
}

/** Compatibility classifier used only at the composition boundary. */
export const retryableTransportError = (error         )          =>
  !(error instanceof ApiError) || error.status >= 500 || error.status === 429;
