import { state, type FeatureRequestCommand, type FeatureRequestDetail, type FeatureRequestPreparation } from '../src/worker/webview/store';
import { fixtureTime, installWorkerFixture } from './worker-fixtures';

/** Stateful offline transport for a single request. It never runs Git or a model. */
export function installPreparationFixture(failed = false) {
  const base = installWorkerFixture('running');
  state.settings!.repositories.items = [{ id: 'web', path: '/example/projects/web', remote: 'origin', branch: 'main', watch: true }];
  const existingChat = JSON.parse(JSON.stringify(base.state.chat)) as typeof state.chat;
  let submitted: FeatureRequestCommand | undefined, saved: FeatureRequestDetail | undefined, finished = false;
  const controller = { creates: [] as FeatureRequestCommand[], cancelled: 0, finish() { finished = true; } };
  function preparation(): FeatureRequestPreparation {
    return { id: submitted!.id, title: submitted!.title, repository: 'web', state: failed ? 'failed' : 'preparing', phase: 'worktree', error: failed ? 'The repository is locked by another Git operation. Check the checkout, then retry.' : null, createdAt: fixtureTime, finishedAt: failed ? fixtureTime : null };
  }
  function accept(): FeatureRequestDetail {
    if (saved) return saved;
    const session = { ...state.sessions!.records.find(item => item.kind === 'local')!, id: 'local-' + submitted!.id, taskId: submitted!.id, title: submitted!.title, status: 'queued', busy: true };
    saved = { session, chat: { ...existingChat!, messages: [{ id: 'prepared-instruction', role: 'user', state: 'complete', at: fixtureTime, text: submitted!.message }], phase: 'queued', busy: true }, featureTracking: state.sessions!.featureTracking };
    state.sessions!.records.push(session);
    const task = { ...state.board!.tasks[0], id: submitted!.id, sessionId: session.id, title: submitted!.title, status: 'queued' as const };
    state.board!.tasks.push(task);
    return saved;
  }
  const fetchFixture: typeof fetch = async (input, init) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (path === '/api/tasks' && body.action === 'create') {
      if (!body.background || !body.files) return Response.json({ error: 'This fixture expects unified background file admission.' }, { status: 400 });
      submitted = structuredClone(body); controller.creates.push(structuredClone(body));
      return Response.json({ preparation: { ...preparation(), state: 'preparing', error: null, finishedAt: null } });
    }
    if (path === '/api/taskboard' && submitted) {
      if (finished) accept();
      return Response.json({ ...state.board, preparations: finished ? [] : [preparation()] });
    }
    if (path === '/api/tasks' && body.action === 'get' && finished) return Response.json(accept());
    if (path === '/api/chat/session') return Response.json({ sessions: state.sessions, chat: state.chat });
    if (path === '/api/sessions' && body.action === 'select') {
      state.sessions!.selected = body.id;
      state.chat = saved && saved.session.id === body.id ? saved.chat : existingChat;
      return Response.json(state.sessions);
    }
    if (path === '/api/chat/cancel') {
      controller.cancelled++;
      state.chat!.busy = false; state.chat!.phase = 'idle';
      return Response.json(state.chat);
    }
    return base.fetchFixture(input, init);
  };
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch; __WERK_PREPARATION_FIXTURE__: typeof controller }).__WERK_STORY_FETCH__ = fetchFixture;
  (window as unknown as { __WERK_PREPARATION_FIXTURE__: typeof controller }).__WERK_PREPARATION_FIXTURE__ = controller;
  return { ...base, controller, fetchFixture };
}

export function installWorktreeLocationFixture() {
  const base = installWorkerFixture('settings-ready');
  state.settings!.repositories = { pollMs: 30_000, worktreeDirectory: '/example/worktrees', items: [{ id: 'web', path: '/example/projects/web', remote: 'origin', branch: 'main', watch: true }] };
  return base;
}

export function installWorktreeDeletionFixture() {
  const base = installWorkerFixture('populated');
  Object.assign(base.file, { worktree: '/example/worktrees/file-review' });
  const fetchFixture: typeof fetch = (input, init) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    if (path === '/api/taskboard/action') return Promise.resolve(Response.json({ error: 'The worktree has uncommitted changes. Uncheck worktree removal to keep those files and delete only the saved task.' }, { status: 409 }));
    return base.fetchFixture(input, init);
  };
  (window as unknown as { __WERK_STORY_FETCH__: typeof fetch }).__WERK_STORY_FETCH__ = fetchFixture;
  return base;
}
