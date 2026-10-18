import { ProviderModelError,                                                                  } from '../application/model-contract.js';
import { sessionDigest, validateModelSessionBinding,                                                                                                       } from '../application/model-session.js';

/** Open a private optimistic fence. Provider identity never grants tool authority. */
export async function openProviderSession(access                                , request              , executable        ) {
  if (!access || request.schemaVersion !== 2 || !request.session) throw new ProviderModelError('session_conflict');
  try { validateModelSessionBinding(access.binding); } catch { throw new ProviderModelError('session_conflict'); }
  if (sessionDigest(request.session) !== sessionDigest(access.binding)) throw new ProviderModelError('session_conflict');
  let previous                   ;
  try { previous = await access.store.load(access.binding); } catch { throw new ProviderModelError('session_conflict'); }
  const recovery = request.sessionRecovery;
  const recovering = recovery !== undefined && recovery.priorDispatchDigest === previous.lastDispatchDigest;
  if (recovery && !recovering && previous.status !== 'idle') throw new ProviderModelError('session_conflict');
  let state                    = recovering ? { ...previous, status: 'idle', checkpoint: undefined } : previous;
  const contextDigest = sessionDigest({ provider: request.provider, executable }), dispatchDigest = sessionDigest(request);
  if (sessionDigest(state.binding) !== sessionDigest(access.binding) || state.status !== 'idle' || state.lastDispatchDigest === dispatchDigest
    || state.checkpoint?.providerContextDigest && state.checkpoint.providerContextDigest !== contextDigest) throw new ProviderModelError('session_conflict');
  const known = new Set(state.checkpoint?.historyDigests ?? []);
  const messages = request.messages.filter(message => !known.has(sessionDigest(message))
    && !(message.role === 'assistant' && sessionDigest(message.text) === state.checkpoint?.resultDigest));
  if (!messages.length) throw new ProviderModelError('session_conflict');
  const messageDigests = request.messages.map(message => sessionDigest(message));
  let started = false, dispatched = false;
  const save = async (next                    ) => {
    try { return await access.store.save(access.binding, state.revision, next); }
    catch { throw new ProviderModelError('session_conflict'); }
  };
  return {
    input: JSON.stringify(messages.map(({ role, text }) => ({ role, content: text }))),
    get checkpoint()                                   { return structuredClone(state.checkpoint ?? {}); },
    get nativeId() { return state.checkpoint?.nativeId; },
    /** Must complete before inference; a native handle is durable at that boundary. */
    async begin(nativeId         ) {
      if (started || state.checkpoint?.nativeId && state.checkpoint.nativeId !== nativeId) throw new ProviderModelError('session_conflict');
      state = await save({ status: 'running', lastDispatchDigest: dispatchDigest,
        checkpoint: { ...state.checkpoint, ...(nativeId ? { nativeId } : {}), providerContextDigest: contextDigest } });
      started = true;
    },
    markDispatched() { if (!started) throw new ProviderModelError('session_conflict'); dispatched = true; },
    async complete(result             , checkpoint                                  = {}) {
      if (!started || !dispatched) throw new ProviderModelError('session_conflict');
      const historyDigests = [...new Set([...(state.checkpoint?.historyDigests ?? []), ...messageDigests])];
      const text = result.type === 'completed' ? result.text : JSON.stringify({ werkInteraction: result.request });
      state = await save({ status: 'idle', lastDispatchDigest: dispatchDigest,
        checkpoint: { ...state.checkpoint, ...checkpoint, historyDigests, resultDigest: sessionDigest(text) } });
      started = false;
    },
    /** Uncertain dispatched work never replays; a proven pre-dispatch failure restores its prior checkpoint. */
    async interrupted() {
      if (!started) return;
      await save(dispatched
        ? { status: 'unknown', checkpoint: state.checkpoint, lastDispatchDigest: dispatchDigest }
        : { status: previous.status, ...(previous.checkpoint ? { checkpoint: previous.checkpoint } : {}), ...(previous.lastDispatchDigest ? { lastDispatchDigest: previous.lastDispatchDigest } : {}) });
      started = false;
    }
  };
}

/** Replay adapters retain the FR checkpoint and uncertainty fence without claiming native resume. */
export async function withReplaySession(request              , access                                , executable        ,
  signal             , control                                    , run                                                            ) {
  if (request.schemaVersion === 1) return run(control);
  if (request.policy.continuation !== 'worker_context_replay') throw new ProviderModelError('session_conflict');
  const session = await openProviderSession(access, request, executable);
  try {
    signal.throwIfAborted();
    await session.begin();
    const result = await run({ ...control, beforeCall() { control?.beforeCall(); session.markDispatched(); } });
    signal.throwIfAborted();
    await session.complete(result);
    return result;
  } catch (error) { await session.interrupted(); throw error; }
}
