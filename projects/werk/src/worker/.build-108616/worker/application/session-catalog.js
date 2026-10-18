import { validateFeatureRequestReference,                              } from './feature-request-reference.js';
                                                           
import { definitionConnection, validateSnapshot } from './definitions.js';
                                                         
                                                               
import { identifier, text } from '../../shared/contracts.js';

                       
            
             
               
            
               
                   
               
                   
                                
                                    
                                  
                          
                                                                                       
                                     
                        
                 
                                          
             
                
                       
                    
                    
 

                                 
                           
                   
                    
 

/** Restore catalog metadata before loading provider-independent transcripts. */
export function restoreSessionCatalog(saved                    , settings                    )                 {
  const catalog                 = { records: [], selected: 'default', changing: false };
    if (saved !== undefined) {
      const value = JSON.parse(saved);
      if (
        !Array.isArray(value.records) ||
        !value.records.length ||
        value.records.length > 100 ||
        new Set(value.records.map((item               ) => item.id)).size !==
          value.records.length
      )
        throw Error("Invalid sessions");
      for (const record of value.records) {
        identifier(record.id, "session");
        text(record.title, "Session title", 120);
        settings.provider(record.provider);
        if (record.feature) validateFeatureRequestReference(record.feature);
        if (record.continuationBlockedReason !== undefined) text(record.continuationBlockedReason, 'Continuation block reason', 1000);
        if (record.definition) {
          validateSnapshot(record.definition);
          definitionConnection(
            settings.provider(record.provider),
            record.definition,
          );
        }
        if (
          typeof record.archived !== "boolean" ||
          !Number.isFinite(Date.parse(record.createdAt))
        )
          throw Error("Invalid session");
      }
      if (
        !value.records.some(
          (record               ) =>
            record.id === value.selected && !record.archived,
        )
      )
        throw Error("Invalid selected session");
      catalog.records = value.records.map((record               ) => ({
        ...record,
        taskId: record.taskId ?? record.id,
        kind: record.kind ?? "chat",
        taskState:
          record.kind === "orchestrator" &&
          ["running", "queued"].includes(record.taskState ?? "")
            ? "failed"
            : record.taskState,
      }));
      catalog.selected = value.selected;
    } else {
      catalog.records = [
        {
          id: "default",
          taskId: "default",
          kind: "chat",
          title: "New task",
          provider: "codex-cli",
          createdAt: new Date().toISOString(),
          archived: false,
        },
      ];
    }
  return catalog;
}
