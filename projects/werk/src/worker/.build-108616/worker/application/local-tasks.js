import { createLocalTaskRuntime } from './local-task-runtime.js';
                                                                                                
                                                                     
                                                               
                                                    
                                                            
                                                                                                                                     

/** Public taskboard facade; one private runtime owns all admission, execution and persistence state. */
export class LocalTaskboard {
                   runtime                  ;
  constructor(settings                    , sessions                , dependencies                       ) {
    this.runtime = createLocalTaskRuntime(settings, sessions, dependencies);
  }
  init() {
    return this.runtime.init();
  }
  get active() { return this.runtime.active; }
  preparation(id        ) {
    return this.runtime.preparation(id);
  }
  preparationDefinition(id        ) {
    return this.runtime.preparationDefinition(id);
  }
  view() {
    return this.runtime.view();
  }
  detail(id        ) {
    return this.runtime.detail(id);
  }
  executionDetail(id        ) {
    return this.runtime.executionDetail(id);
  }
  create(input         , submission                      ) {
    return this.runtime.create(input, submission);
  }
  executeRequest(id        ) {
    return this.runtime.executeRequest(id);
  }
  interact(body                    ) {
    return this.runtime.interact(body);
  }
  action(input         , expectedInteractionRevision         ) {
    return this.runtime.action(input, expectedInteractionRevision);
  }
  tick() {
    return this.runtime.tick();
  }
  close() {
    return this.runtime.close();
  }
}
