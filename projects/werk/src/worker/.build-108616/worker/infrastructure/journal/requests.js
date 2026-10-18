                                                                                 
             
                
               
              
                                             
import {
                        
                 
                        
                 
                      
                       
                    
                    
} from "../../application/request-gates.js";
                                                                       
import { requestBindFeature, requestBindTurn, requestEnsure } from './requests/admission.js';
import { requestCommand, requestPolicy, requestSetPolicy } from './requests/commands.js';
import { requestFailExecution, requestPrepareExecution, requestRecordResult, requestStartExecution } from './requests/execution.js';
import { requestEvaluate, requestHoldRecovery } from './requests/gates.js';
import { requestEvents, requestExecution, requestForSession, requestForTurn, requestHasActiveReview, requestList } from './requests/queries.js';
import { requestCompleteReview, requestFailReview, requestObserveReviewUsage, requestQueuedReviews, requestReserveReview, requestStartReview } from './requests/reviews.js';
import { RequestStore } from './requests/store.js';

/** Authoritative request state. The store alone owns its SQLite connection and transactions. */
export class WorkerRequestJournal                                                    {
                   store              ;
  constructor(directory        ) {
    this.store = new RequestStore(directory);
  }
  async init() {
    return this.store.init();
  }
  async open() { return this.store.open(); }
  recover(retained                      = new Set()) { return this.store.recover(retained); }
  preparedForRecovery(id        ) { return this.store.preparedForRecovery(id); }
  close() {
    return this.store.close();
  }
  bindFeature(sessionId        , featureId        )       {
    requestBindFeature(this.store, sessionId, featureId);
  }
  get(id        )                {
    return this.store.get(id);
  }
  execution(id        , turnId        ) {
    return requestExecution(this.store, id, turnId);
  }
  hasActiveReview(sessionId        )          {
    return requestHasActiveReview(this.store, sessionId);
  }
  forSession(sessionId        )                            {
    return requestForSession(this.store, sessionId);
  }
  forTurn(sessionId        , turnId        )                            {
    return requestForTurn(this.store, sessionId, turnId);
  }
  list(
    options   
                         
                     
                     
                     
                      
      = {},
  ) {
    return requestList(this.store, options);
  }
  events(id        , after = 0, limit = 100) {
    return requestEvents(this.store, id, after, limit);
  }
  ensure(input   
                        
                     
                            
                                     
   )                {
    return requestEnsure(this.store, input);
  }
  bindTurn(id        , turnId        , inputRevision         ) {
    return requestBindTurn(this.store, id, turnId, inputRevision);
  }
  evaluate(id        , stage           ) {
    return requestEvaluate(this.store, id, stage);
  }
  holdRecovery(id        , reason = "checkpoint_ownership") {
    return requestHoldRecovery(this.store, id, reason);
  }
  prepareExecution(id        , turnId        , runId        ) {
    return requestPrepareExecution(this.store, id, turnId, runId);
  }
  startExecution(id        , turnId        , runId        ) {
    return requestStartExecution(this.store, id, turnId, runId);
  }
  recordResult(
    id        ,
    turnId        ,
    runId        ,
    result             ,
    facts                   = {},
  ) {
    return requestRecordResult(this.store, id, turnId, runId, result, facts);
  }
  failExecution(
    id        ,
    turnId        ,
    status                                        ,
  ) {
    return requestFailExecution(this.store, id, turnId, status);
  }
  reserveReview(id        , stage           )                   {
    return requestReserveReview(this.store, id, stage);
  }
  queuedReviews(limit = 20)                     {
    return requestQueuedReviews(this.store, limit);
  }
  startReview(
    id        ,
    intentId        ,
    runId        ,
    dispatch              ,
  )                   {
    return requestStartReview(this.store, id, intentId, runId, dispatch);
  }
  observeReviewUsage(id        , intentId        , usage               ) {
    return requestObserveReviewUsage(this.store, id, intentId, usage);
  }
  completeReview(
    id        ,
    intentId        ,
    result                                         ,
    usage               ,
  )                {
    return requestCompleteReview(this.store, id, intentId, result, usage);
  }
  failReview(
    id        ,
    intentId        ,
    code        ,
    usage                ,
  ) {
    return requestFailReview(this.store, id, intentId, code, usage);
  }
  command(input                )   
                           
                       
    {
    return requestCommand(this.store, input);
  }
  policy() {
    return requestPolicy(this.store);
  }
  setPolicy(input   
                    
                             
                        
   ) {
    return requestSetPolicy(this.store, input);
  }
  deleteSession(sessionId        ) {
    return this.store.deleteSession(sessionId);
  }
}
