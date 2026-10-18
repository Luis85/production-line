import { randomUUID } from "node:crypto";
             
               
                                                
import {
  gateDigest,
  validateGateInput,
  validateGatePolicy,
                 
                    
                    
} from "../../../application/request-gates.js";
import { requestPolicy } from './commands.js';
import { requestForTurn } from './queries.js';
                                               
import { clone, conflict, identifier, iso, owner, provider } from './values.js';

export function requestEnsure(store              , input   
                      
                   
                          
                                   
 )                {
  const owned = owner(input.owner),
    accepted = validateGateInput(input.input),
    policy = validateGatePolicy(input.policy ?? requestPolicy(store).policy),
    profile = provider(input.provider);
  return store.transaction(() => {
    const prior = requestForTurn(store, owned.sessionId, owned.rootTurnId);
    if (prior) {
      const original = JSON.parse(
        String(
          store.database()
            .prepare(
              "SELECT payload FROM request_generations WHERE request_id=? AND input_revision=1",
            )
            .get(prior.id) .payload,
        ),
      );
      if (
        original.inputHash !== gateDigest(accepted) ||
        original.policyDigest !==
          gateDigest(input.policy ?? original.policy) ||
        gateDigest(original.provider) !== gateDigest(profile) ||
        gateDigest({
          ...prior.owner,
          remote: prior.owner.remote
            ? {
                origin: prior.owner.remote.origin,
                taskId: prior.owner.remote.taskId,
              }
            : null,
        }) !==
          gateDigest({
            ...owned,
            remote: owned.remote
              ? { origin: owned.remote.origin, taskId: owned.remote.taskId }
              : null,
          })
      )
        conflict(
          "This request intent already belongs to different input or policy.",
        );
      return prior;
    }
    const at = iso();
    const request                = {
      schemaVersion: 1,
      id: randomUUID(),
      owner: owned,
      revision: 0,
      inputRevision: 1,
      input: accepted,
      inputHash: gateDigest(accepted),
      policy,
      policyDigest: gateDigest(policy),
      provider: profile,
      phase: "readiness",
      assignee: "operator",
      createdAt: at,
      updatedAt: at,
      reworkCount: 0,
      evaluations: [],
      findings: [],
      candidates: [],
      reviews: [],
      execution: null,
      attestation: null,
    };
    store.database()
      .prepare(
        "INSERT INTO worker_requests(id,session_id,root_turn_id,phase,payload) VALUES(?,?,?,?,?)",
      )
      .run(
        request.id,
        owned.sessionId,
        owned.rootTurnId,
        request.phase,
        "{}",
      );
    store.generation(request);
    store.save(request, "accepted");
    return clone(request);
  });
}

export function requestBindTurn(store              , id        , turnId        , inputRevision         ) {
  identifier(turnId, "turn ID");
  return store.transaction(() => {
    const request = store.get(id),
      revision = inputRevision ?? request.inputRevision;
    if (revision !== request.inputRevision)
      conflict("The accepted request input changed.");
    const existing = store.database()
      .prepare(
        "SELECT request_id,input_revision FROM request_turns WHERE session_id=? AND turn_id=?",
      )
      .get(request.owner.sessionId, turnId);
    if (existing) {
      if (
        existing.request_id !== id ||
        Number(existing.input_revision) !== revision
      )
        conflict("This turn already belongs to another request generation.");
      return request;
    }
    store.database()
      .prepare(
        "INSERT INTO request_turns(session_id,turn_id,request_id,input_revision) VALUES(?,?,?,?)",
      )
      .run(request.owner.sessionId, turnId, id, revision);
    store.save(request, "turn_bound", { turnId });
    return request;
  });
}

/** Upgrade metadata in the existing authority; never create an execution or change accepted input. */
export function requestBindFeature(store              , sessionId        , featureId        )       {
  identifier(sessionId, 'session ID'); identifier(featureId, 'feature ID');
  store.transaction(() => {
    const rows = store.database().prepare('SELECT id FROM worker_requests WHERE session_id=?').all(sessionId);
    for (const row of rows) {
      const request = store.get(String(row.id));
      if (request.owner.featureId && request.owner.featureId !== featureId)
        conflict('The accepted execution belongs to another Feature Request.');
      if (!request.owner.featureId) {
        request.owner.featureId = featureId;
        store.save(request, 'feature_identity_bound');
      }
    }
  });
}
