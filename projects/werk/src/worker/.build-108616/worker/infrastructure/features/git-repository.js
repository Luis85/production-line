                                                                                                  
import { approvedPathsCollide } from '../../application/approved-paths.js';
import { containsSensitivePatchMaterial } from '../../application/review-patch-policy.js';
import { acceptedSharedBody, sharedSourceProjectionKeys } from './shared-progress.js';
import { requestName, parseFeature } from './document.js';
import { canonicalJson } from '../../application/request-gates.js';
import { branchName, commitId, FeatureGitIo, GitFeatureError, gitPath, hash, textBytes,              } from './git-io.js';
                                                             

export { GitFeatureError } from './git-io.js';
                                              
                                                                                                         
                                                                                                                      
 
                                                                                                  
                                                                                
                                                                                                     
                                          
                      
                                                           
                                 
 
                                                                                                                                              
                                                                                                                
                                                                                              
const revision = (value         )                  => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const operation = (value        ) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new GitFeatureError('invalid_input', 'Use a bounded stable publication operation ID.');
};
const beneath = (path        , directory        ) => path.startsWith(directory + '/');
function unchangedRequest(before        , after        ) {
  if (before === after) return;
  const old = parseFeature(before), next = parseFeature(after);
  const immutable = (value                         ) => Object.fromEntries(Object.entries(value).filter(([key]) => !['id', 'status', 'werk', ...sharedSourceProjectionKeys].includes(key)));
  if (acceptedSharedBody(old) !== acceptedSharedBody(next) || canonicalJson(immutable(old.data)) !== canonicalJson(immutable(next.data)) || old.data.id !== undefined && old.data.id !== next.data.id)
    throw new GitFeatureError('conflict', 'Lifecycle publication may update only the request ID, status and worker metadata; accepted developer content is preserved.');
}

/** A remote-confirmed claim precedes admission; publication is retryable and never resets a developer checkout. */
export class GitFeatureRepository {
           options                                       ;
                   io              ;
                   shutdown = new AbortController();
          publication                   = Promise.resolve();
  constructor(options                             ) {
    operation(options.workerId); branchName(options.branch); branchName(options.branchPrefix ?? 'werk/features');
    gitPath(options.requestsDirectory); gitPath(options.reviewDirectory);
    const tasks = options.tasksDirectory ?? options.reviewDirectory + '/_tasks';
    gitPath(tasks);
    if (tasks === options.requestsDirectory || beneath(tasks, options.requestsDirectory) || beneath(options.requestsDirectory, tasks) || tasks === options.reviewDirectory || beneath(options.reviewDirectory, tasks) || tasks === options.reviewDirectory + '/_operations' || beneath(tasks, options.reviewDirectory + '/_operations')) throw new GitFeatureError('invalid_input', 'Task notes must stay separate from request intake and publication receipts.');
    if (options.requestsDirectory === options.reviewDirectory || beneath(options.requestsDirectory, options.reviewDirectory) || beneath(options.reviewDirectory, options.requestsDirectory)) throw new GitFeatureError('invalid_input', 'Shared request and review directories must be separate.');
    if (options.protectedPaths && (!Array.isArray(options.protectedPaths) || options.protectedPaths.length > 16)) throw new GitFeatureError('invalid_input', 'Bound the protected workflow paths.');
    for (const path of options.protectedPaths ?? []) gitPath(path);
    this.options = Object.freeze(structuredClone(options)); this.io = new FeatureGitIo(options);
  }
          signal(signal              ) { return AbortSignal.any([this.shutdown.signal, ...(signal ? [signal] : []), AbortSignal.timeout(120000)]); }
          serialize   (action                  ) {
    const pending = this.publication.catch(() => {}).then(action); this.publication = pending; return pending;
  }
  async close() { this.shutdown.abort(); await this.publication.catch(() => {}); }
  async head(signal              )                  {
    const bounded = this.signal(signal), root = await this.io.root(bounded);
    return (await this.io.fetch(root, this.options.branch, bounded)) ;
  }
  async read(commit        , path        , signal              )                                                        {
    const bounded = this.signal(signal), blob = await this.io.blob(await this.io.root(bounded), commit, path, bounded);
    return blob && { revision: blob.revision, content: blob.content };
  }
  async readBlob(commit        , path        , signal              )                         { return (await this.read(commit, path, signal))?.content ?? null; }
  async list(commit        , requestsDirectory = this.options.requestsDirectory, signal              )                            {
    if (!commitId(commit)) throw new GitFeatureError('invalid_input', 'List requests at a full source commit identifier.');
    gitPath(requestsDirectory);
    const bounded = this.signal(signal), root = await this.io.root(bounded);
    const directoryEntry = await this.io.output(root.path, ['ls-tree', '-z', commit, '--', requestsDirectory], bounded);
    if (!directoryEntry) return [];
    if (!directoryEntry.startsWith('040000 tree ') || directoryEntry.slice(directoryEntry.indexOf('\t') + 1) !== requestsDirectory + '\0') throw new GitFeatureError('conflict', 'Shared intake must be a tracked directory.');
    const listing = await this.io.output(root.path, ['ls-tree', '-z', `${commit}:${requestsDirectory}`], bounded);
    const names = listing.split('\0').filter(Boolean).map(entry => entry.slice(entry.indexOf('\t') + 1)).filter(requestName).sort();
    if (names.length > 1000) throw new GitFeatureError('conflict', 'Shared intake holds more than 1,000 Markdown requests.');
    const files                   = []; let bytes = 0;
    for (const name of names) {
      const path = requestsDirectory + '/' + name, blob = await this.io.blob(root, commit, path, bounded);
      if (!blob) throw new GitFeatureError('conflict', 'Pinned shared request disappeared.');
      bytes += Buffer.byteLength(blob.content);
      if (bytes > 16 * 1024 * 1024) throw new GitFeatureError('conflict', 'Shared intake content exceeds 16 MiB.');
      files.push({ name, path, revision: blob.revision, content: blob.content });
    }
    return files;
  }
  async snapshot(signal              )                              { const commit = await this.head(signal); return { commit, files: await this.list(commit, this.options.requestsDirectory, signal) }; }
          validateLifecycle(input                         ) {
    operation(input.operationId);
    const path = gitPath(input.request.path), name = path.slice(this.options.requestsDirectory.length + 1);
    if (!beneath(path, this.options.requestsDirectory) || !requestName(name) || !revision(input.request.expectedRevision)) throw new GitFeatureError('invalid_input', 'Lifecycle publication requires one guarded request in the configured intake directory.');
    textBytes(input.request.content, 65536);
    const changes = [input.request, ...(input.artifacts ?? [])];
    if (changes.length > 65 || new Set(changes.map(change => change.path)).size !== changes.length) throw new GitFeatureError('invalid_input', 'Publication paths must be unique and bounded.');
    let bytes = 0;
    for (const [index, change] of changes.entries()) {
      gitPath(change.path); textBytes(change.content, index ? 524288 : 65536); bytes += Buffer.byteLength(change.content);
      if (index && (!(beneath(change.path, this.options.reviewDirectory) || beneath(change.path, this.options.tasksDirectory ?? this.options.reviewDirectory + '/_tasks')) || change.path === this.options.reviewDirectory + '/_operations' || beneath(change.path, this.options.reviewDirectory + '/_operations'))) throw new GitFeatureError('invalid_input', 'Lifecycle artifacts must stay in the configured review or Task directories outside operation receipts.');
      if (change.expectedRevision !== null && !revision(change.expectedRevision)) throw new GitFeatureError('invalid_input', 'Provide each existing publication file revision, or null for a new file.');
    }
    if (bytes > 2 * 1024 * 1024) throw new GitFeatureError('invalid_input', 'Lifecycle publication exceeds 2 MiB.');
    return changes;
  }
          async receipt(root                , head        , path        , expected        , operationId        , signal             )                                        {
    const blob = await this.io.blob(root, head, path, signal);
    if (!blob) return null;
    if (blob.content !== expected) throw new GitFeatureError('conflict', 'This publication operation ID already belongs to different content or a different worker.');
    const commit = (await this.io.output(root.path, ['log', '-1', '--format=%H', head, '--', path], signal)).trim();
    if (!commitId(commit)) throw new GitFeatureError('conflict', 'Published operation receipt has no verifiable commit.');
    return { commit, head, operationId, replayed: true };
  }
  publishLifecycle(value                         , signal              )                                 {
    const input = structuredClone(value), changes = this.validateLifecycle(input), bounded = this.signal(signal);
    return this.publishGuarded(input.operationId, changes, bounded, async (_root, _head, originals) => {
      unchangedRequest(originals.get(input.request.path) .content, input.request.content);
    });
  }
  publishRequest(value                           , signal              )                                 {
    const input = structuredClone(value), bounded = this.signal(signal);
    operation(input.operationId);
    const path = gitPath(input.request.path), name = path.slice(this.options.requestsDirectory.length + 1);
    if (!beneath(path, this.options.requestsDirectory) || !requestName(name) || input.request.expectedRevision !== null && !revision(input.request.expectedRevision)) throw new GitFeatureError('invalid_input', 'Request authoring requires one guarded request in the configured intake directory.');
    textBytes(input.request.content, 65536);
    const next = this.authoringRequest(input.request.content);
    if (!Array.isArray(input.workflowFiles) || !input.workflowFiles.length || input.workflowFiles.length > 8 || new Set(input.workflowFiles.map(file => file.path)).size !== input.workflowFiles.length) throw new GitFeatureError('invalid_input', 'Provide the bounded workflow files used to prepare this request.');
    for (const file of input.workflowFiles) { gitPath(file.path); if (!revision(file.sha256)) throw new GitFeatureError('invalid_input', 'Workflow files require their exact SHA-256 revisions.'); }
    if (!revision(input.workflowDigest) || !input.binding || input.binding.remote !== this.options.remote || input.binding.branch !== this.options.branch || typeof input.binding.repositoryId !== 'string' || !input.binding.repositoryId || typeof input.binding.workflowPath !== 'string') throw new GitFeatureError('invalid_input', 'Authoring publication requires its exact prepared workflow and repository binding.');
    gitPath(input.binding.workflowPath);
    return this.publishGuarded(input.operationId, [input.request], bounded, async (root, head, originals) => {
      if (hash(canonicalJson([...input.workflowFiles].sort((a, b) => a.path.localeCompare(b.path)))) !== input.workflowDigest) throw new GitFeatureError('conflict', 'The shared template or checks changed. Prepare the request again before publishing.');
      if (input.readinessError) throw new GitFeatureError('invalid_input', input.readinessError);
      for (const file of input.workflowFiles) if ((await this.io.blob(root, head, file.path, bounded))?.revision !== file.sha256) throw new GitFeatureError('conflict', 'The shared workflow changed before publication. Prepare this request again.');
      const before = originals.get(path);
      if (before) {
        const previous = this.authoringRequest(before.content);
        if (previous.status !== 'draft' || previous.id !== next.id) throw new GitFeatureError('conflict', 'Only the same unclaimed draft can be revised. Ready requests retain their accepted identity and content.');
      } else await this.assertNoAlias(root.path, head, path, bounded);
      for (const file of await this.list(head, this.options.requestsDirectory, bounded)) {
        if (file.path === path) continue;
        let id         ; try { id = parseFeature(file.content).data.id; } catch { continue; }
        if (id === next.id) throw new GitFeatureError('conflict', 'This feature ID already belongs to another request. Open that request or create a new identity.');
      }
    }, { workflowDigest: input.workflowDigest, binding: input.binding });
  }
          authoringRequest(markdown        ) {
    const { data } = parseFeature(markdown);
    if (typeof data.id !== 'string' || data.id.startsWith('remote-') || !['draft', 'ready'].includes(String(data.status)) || data.mode !== 'patch' || typeof data.templateId !== 'string' || ['source', 'werk', 'werkOwner', 'werkTask', 'werkPullRequest', 'werkTracking'].some(key => Object.hasOwn(data, key)) || data.type === 'Task' || data.type === 'PullRequest') throw new GitFeatureError('conflict', 'Author only unclaimed draft or ready feature requests with a stable ID and template.');
    return data;
  }
          publishGuarded(operationId        , changes                    , bounded             , validate                                                                                               , intent                                                                )                                 {
    return this.serialize(async () => {
      const root = await this.io.root(bounded), digest = hash(canonicalJson({ workerId: this.options.workerId, branch: this.options.branch, changes, ...(intent ? { authoring: intent } : {}) }));
      const marker = `${this.options.reviewDirectory}/_operations/${hash(operationId)}.json`;
      const receipt = JSON.stringify({ schemaVersion: 1, workerId: this.options.workerId, operationId, digest }) + '\n';
      for (let attempt = 0; attempt < 3; attempt++) {
        const head = (await this.io.fetch(root, this.options.branch, bounded)) ;
        const previous = await this.receipt(root, head, marker, receipt, operationId, bounded);
        if (previous) return previous;
        const originals = new Map                        ();
        for (const change of changes) {
          const before = await this.io.blob(root, head, change.path, bounded, 524288); originals.set(change.path, before);
          if ((before?.revision ?? null) !== change.expectedRevision) throw new GitFeatureError('conflict', 'Shared feature content changed before publication. Refresh the remote request and preserve the teammate edit.');
        }
        await validate(root, head, originals);
        const commit = await this.io.worktree(root, head, bounded, async worktree => {
          for (const change of changes) await this.io.write(worktree, change.path, change.content, originals.get(change.path)?.mode ?? '100644', bounded);
          await this.io.write(worktree, marker, receipt, '100644', bounded);
          return this.io.commit(worktree, head, operationId, digest, bounded);
        });
        // A lost push acknowledgement is resolved by reading the immutable receipt before retrying.
        try { await this.io.push(root, commit, this.options.branch, bounded); }
        catch (error) { if (bounded.aborted) throw error; }
        const confirmedHead = (await this.io.fetch(root, this.options.branch, bounded)) ;
        const confirmed = await this.receipt(root, confirmedHead, marker, receipt, operationId, bounded);
        if (confirmed) return { ...confirmed, replayed: false };
      }
      throw new GitFeatureError('conflict', 'Shared intake advanced repeatedly. Publication remains pending and can be retried.');
    });
  }
          async branchReceipt(root                , head        , input                     , digest        , expectedTree        , signal             ) {
    const history = await this.io.output(root.path, ['log', '--max-count=128', '--format=%H%x00%B%x00', head], signal);
    const entries = history.split('\0');
    for (let i = 0; i + 1 < entries.length; i += 2) {
      const commit = entries[i] .trim(), message = entries[i + 1] ;
      if (!message.split('\n').includes(`Werk-Operation: ${input.operationId}`) || !message.split('\n').includes(`Werk-Payload: ${digest}`)) continue;
      if ((await this.io.output(root.path, ['rev-list', '--parents', '-n', '1', commit], signal)).trim() !== `${commit} ${input.sourceCommit}`) continue;
      // Remote commit messages are untrusted receipts: a copied message does not
      // prove that the branch still contains the worker's exact approved patch.
      if ((await this.io.output(root.path, ['rev-parse', `${commit}^{tree}`], signal)).trim() !== expectedTree) continue;
      return { commit, head, operationId: input.operationId, replayed: true };
    }
    throw new GitFeatureError('conflict', 'The feature branch already belongs to different work. Existing commits were preserved.');
  }
  /** A new file must not alias a tracked name that differs only by case or Unicode normalization. */
          async assertNoAlias(worktree        , commit        , path        , signal             ) {
    const parts = path.split('/'), key = (name        ) => name.normalize('NFC').toLowerCase();
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      const names = (await this.io.output(worktree, ['ls-tree', '-z', '--name-only', commit, ...(parent ? ['--', parent + '/'] : [])], signal)).split('\0').filter(Boolean).map(entry => entry.slice(parent ? parent.length + 1 : 0));
      if (names.some(name => name !== parts[i] && key(name) === key(parts[i] ))) throw new GitFeatureError('conflict', 'Feature patch adds a path that differs from an existing file or folder only by case or Unicode normalization.');
    }
  }
  publishPatch(value                     , signal              )                                       {
    const input = structuredClone(value), bounded = this.signal(signal); operation(input.operationId);
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(input.featureId) || !commitId(input.sourceCommit) || !Array.isArray(input.approvedPaths) || !input.approvedPaths.length || input.approvedPaths.length > 32 || new Set(input.approvedPaths).size !== input.approvedPaths.length) throw new GitFeatureError('invalid_input', 'Feature publication requires a stable feature ID, source commit and explicit approved paths.');
    textBytes(input.patch, 131072);
    if (!input.patch.trim() || containsSensitivePatchMaterial(input.patch)) throw new GitFeatureError('invalid_input', 'Feature patch is empty or contains sensitive material.');
    for (const path of input.approvedPaths) {
      gitPath(path);
      const normalized = path.toLowerCase();
      if (normalized === '.werk' || beneath(normalized, '.werk')) throw new GitFeatureError('invalid_input', 'Feature patches cannot modify worker control storage.');
      if ([this.options.requestsDirectory, this.options.reviewDirectory, this.options.tasksDirectory ?? this.options.reviewDirectory + '/_tasks'].some(directory => normalized === directory.toLowerCase() || beneath(normalized, directory.toLowerCase())) || (this.options.protectedPaths ?? []).some(protectedPath => normalized === protectedPath.toLowerCase())) throw new GitFeatureError('invalid_input', 'Feature patches cannot modify their workflow configuration, request intake or review artifacts.');
    }
    if (approvedPathsCollide(input.approvedPaths)) throw new GitFeatureError('invalid_input', 'Approved feature paths must be unique without file or folder aliases.');
    const branch = branchName(`${this.options.branchPrefix ?? 'werk/features'}/${input.featureId}-${hash(input.operationId).slice(0, 12)}`);
    const digest = hash(canonicalJson({ ...input, approvedPaths: [...input.approvedPaths].sort() }));
    return this.serialize(async () => {
      const root = await this.io.root(bounded), prior = await this.io.fetch(root, branch, bounded, true);
      const publication = await this.io.worktree(root, input.sourceCommit, bounded, async worktree => {
        await this.io.output(worktree, ['apply', '--check', '--index', '--whitespace=nowarn', '-'], bounded, input.patch);
        await this.io.output(worktree, ['apply', '--index', '--whitespace=nowarn', '-'], bounded, input.patch);
        const raw = (await this.io.output(worktree, ['diff', '--cached', '--raw', '-z', '--no-renames'], bounded)).split('\0').filter(Boolean);
        if (!raw.length || raw.length % 2 || raw.length > 64) throw new GitFeatureError('conflict', 'Feature patch must contain a bounded set of approved file changes.');
        for (let i = 0; i < raw.length; i += 2) {
          const match = /^:(000000|100644|100755) (000000|100644|100755) [a-f0-9]+ [a-f0-9]+ ([AMD])$/.exec(raw[i] );
          const regularChange = match && (match[3] === 'A' ? match[1] === '000000' && match[2] !== '000000'
            : match[3] === 'D' ? match[1] !== '000000' && match[2] === '000000'
              : match[1] !== '000000' && match[1] === match[2]);
          if (!regularChange || !input.approvedPaths.includes(raw[i + 1] )) throw new GitFeatureError('conflict', 'Feature patch changed an unapproved path, file mode or file type.');
          if (match [3] === 'A') await this.assertNoAlias(worktree, input.sourceCommit, raw[i + 1] , bounded);
        }
        const tree = (await this.io.output(worktree, ['write-tree'], bounded)).trim();
        return { tree, commit: prior ? null : await this.io.commit(worktree, input.sourceCommit, input.operationId, digest, bounded) };
      });
      if (prior) return { ...await this.branchReceipt(root, prior, input, digest, publication.tree, bounded), branch };
      try { await this.io.push(root, publication.commit , branch, bounded); }
      catch (error) { if (bounded.aborted) throw error; }
      const head = await this.io.fetch(root, branch, bounded, true);
      if (!head) throw new GitFeatureError('unavailable', 'Feature branch publication is unconfirmed. Keep the result and retry publication.');
      return { ...await this.branchReceipt(root, head, input, digest, publication.tree, bounded), branch, replayed: false };
    });
  }
}
