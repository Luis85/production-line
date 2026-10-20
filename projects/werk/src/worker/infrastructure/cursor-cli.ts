import { requireAuthenticationSelection } from './provider-authentication.js';
import { join } from 'node:path';
import { currentToolManifest, withProviderTools, type ProviderOptions } from './provider-tool-session.js';
import { legacyModelReply, modelCapabilities, observeModelInvocation, ProviderModelError, requireModelRequest, type StructuredModel } from '../application/model-contract.js';
import type { ProviderConnection } from '../application/provider-contract.js';
import { sessionDigest } from '../application/model-session.js';
import { ensureDirectory } from './journal/files.js';
import { cursorReply } from './cursor-session.js';

/** Cursor owns native tools, hooks and subagents. Werk's optional bridge is supplemental authority. */
export function cursorModel(connection: ProviderConnection, directory: string, options: ProviderOptions): StructuredModel {
  const model: StructuredModel = {
    ...(options.session ? { sessionBinding: structuredClone(options.session.binding) } : {}),
    configuration: Object.freeze({ id: connection.id, model: connection.model, instruction: connection.instruction ?? '', ...(connection.authenticationMode ? { authenticationMode: connection.authenticationMode } : {}), ...(connection.effort === undefined ? {} : { effort: connection.effort }) }),
    get toolManifest() { return currentToolManifest(options.tools); },
    toolManifestFor(policy) { return currentToolManifest(options.tools, policy); },
    capabilities: { ...modelCapabilities, tools: 'provider_native', ...(options.session ? { continuation: 'provider_session', nativeResume: true } : {}) },
    reply(messages, signal, onUsage) { return legacyModelReply(model, messages, signal, onUsage); },
    execute(request, signal, onUsage, control) {
      requireModelRequest(request, 'cursor-cli');
      requireAuthenticationSelection(connection, request.provider.authenticationMode);
      return observeModelInvocation(signal, onUsage, observe => withProviderTools(request, signal, options.tools, async (runtime, bounded) => {
        let workspace = join(directory, 'model-workspaces', options.session ? sessionDigest(options.session.binding) : 'cursor-chat');
        if (request.policy.development) {
          if (!runtime?.nativeWorkspace) { const error = new ProviderModelError('tool_access'); error.message = 'Cursor implementation requires the retained candidate worktree.'; throw error; }
          workspace = await runtime.nativeWorkspace(bounded);
        } else await ensureDirectory(workspace);
        return cursorReply(connection, workspace, request, bounded, options.session, observe, runtime, control);
      }, control));
    }
  };
  return model;
}
