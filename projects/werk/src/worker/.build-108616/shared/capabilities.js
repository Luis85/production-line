import { identifier, object } from './contracts.js';
import { ValidationError } from './errors.js';
                                                 

                                                                                                       
                                                                                                                                                                        
                                                                                                                                                                                                                                                                                                                                
                                                                  
                     
                    
                                        
                                  
                                                                           
                                                                              
 
/** Remote capability announcements are bounded allowlisted data, never arbitrary configuration. */
export function validateLineCapabilities(value         , expectedProject         )                   {
    const body = object(value, 'Line capabilities', ['schemaVersion', 'project', 'execution', 'context', 'intake', 'providers', 'profiles', 'profilesTruncated', 'capacity', 'eligibleCapacity', 'repositoryCapacity', 'repositoryCapacityTruncated']);
    const project = identifier(body.project, 'capabilities.project');
    if (body.schemaVersion !== 1 || !['mock', 'cli', 'mixed'].includes(body.execution          ) || !['unbound', 'pinned'].includes(body.context          ) || (expectedProject !== undefined && project !== expectedProject)) throw new ValidationError('Unsupported or mismatched line capabilities');
    const context = body.context                               ;
    const intake = context === 'pinned' ? ['requirement_ref', 'pinned_iteration']          : ['structured_task', 'requirement_ref']         ;
    if (!Array.isArray(body.intake) || body.intake.length !== intake.length || new Set(body.intake).size !== body.intake.length || body.intake.some(item => !intake.includes(item))) throw new ValidationError('Invalid line intake capabilities');
    if (!Array.isArray(body.providers) || body.providers.length > 2 || new Set(body.providers).size !== body.providers.length || body.providers.some(provider => !['claude', 'codex'].includes(provider))) throw new ValidationError('Invalid line provider capabilities');
    if (!Array.isArray(body.profiles) || body.profiles.length > 64 || typeof body.profilesTruncated !== 'boolean') throw new ValidationError('Invalid or oversized line profile capabilities');
    const providers = body.providers                          ;
    const profiles = body.profiles.map(value => {
        const profile = object(value, 'Capability profile', ['id', 'provider', 'mode']);
        if (!['claude', 'codex'].includes(profile.provider          ) || !providers.includes(profile.provider                      )) throw new ValidationError('Invalid capability profile provider');
        if (profile.mode !== undefined && (!['mock', 'cli'].includes(profile.mode          ) || (profile.mode === 'cli' && profile.provider !== 'codex'))) throw new ValidationError('Invalid capability mode');
        return { ...(profile.mode === undefined ? {} : { mode: profile.mode                   }), id: identifier(profile.id, 'capability profile ID'), provider: profile.provider                       };
    });
    if (new Set(profiles.map(profile => `${profile.id}:${profile.provider}:${profile.mode ?? 'mock'}`)).size !== profiles.length) throw new ValidationError('Duplicate capability profiles');
    if ((body.profilesTruncated && profiles.length !== 64) || (!body.profilesTruncated && providers.some(provider => !profiles.some(profile => profile.provider === provider)))) throw new ValidationError('Inconsistent profile capability coverage');
    const capacity = object(body.capacity, 'Observed capacity', ['kind', 'observedAt', 'workers']);
    if (capacity.kind !== 'observed' || typeof capacity.observedAt !== 'string' || capacity.observedAt.length > 40 || !Number.isFinite(Date.parse(capacity.observedAt))) throw new ValidationError('Invalid capacity observation');
    const keys = ['total', 'online', 'offline', 'slotsTotal', 'slotsBusy', 'slotsAvailable']         ;
    const workers = object(capacity.workers, 'Observed workers', keys);
    for (const key of keys) if (!Number.isSafeInteger(workers[key]) || Number(workers[key]) < 0) throw new ValidationError('Invalid observed worker counts');
    const counts = Object.fromEntries(keys.map(key => [key, workers[key]]))                           ;
    if (counts.total !== counts.online + counts.offline || counts.slotsBusy + counts.slotsAvailable > counts.slotsTotal) throw new ValidationError('Inconsistent observed worker capacity');
    let eligibleCapacity                                            ;
    if (body.eligibleCapacity !== undefined) {
        if (!Array.isArray(body.eligibleCapacity) || body.eligibleCapacity.length > 4) throw new ValidationError('Invalid eligible capacity');
        eligibleCapacity = body.eligibleCapacity.map(value => {
            const row = object(value, 'Eligible capacity', ['provider', 'mode', 'slotsAvailable']);
            if (!['codex', 'claude'].includes(row.provider          ) || !['mock', 'cli'].includes(row.mode          ) || !Number.isSafeInteger(row.slotsAvailable) || Number(row.slotsAvailable) < 0) throw new ValidationError('Invalid eligible capacity');
            return { provider: row.provider                      , mode: row.mode                  , slotsAvailable: Number(row.slotsAvailable) };
        });
        if (new Set(eligibleCapacity.map(row => row.provider + ':' + row.mode)).size !== eligibleCapacity.length) throw new ValidationError('Duplicate eligible capacity');
    }
    let repositoryCapacity                                  ;
    if (body.repositoryCapacity !== undefined) {
        if (!Array.isArray(body.repositoryCapacity) || body.repositoryCapacity.length > 260 || typeof body.repositoryCapacityTruncated !== 'boolean') throw new ValidationError('Invalid repository capacity.');
        repositoryCapacity = body.repositoryCapacity.map(value => {
            const row = object(value, 'Repository capacity', ['repositoryId', 'implicitOnly', 'provider', 'mode', 'slotsAvailable']);
            if (!['codex', 'claude'].includes(row.provider          ) || !['mock', 'cli'].includes(row.mode          ) || !Number.isSafeInteger(row.slotsAvailable) || Number(row.slotsAvailable) < 0 || (row.implicitOnly !== undefined && typeof row.implicitOnly !== 'boolean')) throw new ValidationError('Invalid repository capacity.');
            const repositoryId = row.repositoryId === null ? null : identifier(row.repositoryId, 'Repository capacity ID');
            if (row.implicitOnly && (repositoryId === null || row.mode !== 'cli')) throw new ValidationError('Invalid implicit repository capacity.');
            return { repositoryId, ...(row.implicitOnly ? { implicitOnly: true } : {}), provider: row.provider                      , mode: row.mode                  , slotsAvailable: Number(row.slotsAvailable) };
        });
        if (new Set(repositoryCapacity.map(row => JSON.stringify([row.repositoryId, !!row.implicitOnly, row.provider, row.mode]))).size !== repositoryCapacity.length || (body.repositoryCapacityTruncated && repositoryCapacity.length !== 260)) throw new ValidationError('Inconsistent repository capacity.');
    } else if (body.repositoryCapacityTruncated !== undefined) throw new ValidationError('Repository capacity is required with its truncation flag.');
    return { ...(repositoryCapacity ? { repositoryCapacity, repositoryCapacityTruncated: body.repositoryCapacityTruncated            } : {}), ...(eligibleCapacity ? { eligibleCapacity } : {}), schemaVersion: 1, project, execution: body.execution                                 , context, intake: [...intake], providers: [...providers], profiles, profilesTruncated: body.profilesTruncated,
        capacity: { kind: 'observed', observedAt: capacity.observedAt, workers: counts } };
}
