<script setup lang="ts">
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import UTextarea from '@nuxt/ui/components/Textarea.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import { toolLimitSeconds, type ToolAccessEditor } from '../tool-access-editor';
const props = defineProps<{ editor: ToolAccessEditor }>();
const transports = [{ label: 'Local process · stdio', value: 'stdio' }, { label: 'HTTP server', value: 'http' }];
const tools = (id: string) => props.editor.savedConnection(id)?.discoveredTools ?? [];
</script>
<template>
  <section aria-labelledby="mcp-connections-title" class="mcp-editor">
    <div class="section-heading"><h3 id="mcp-connections-title">MCP connections</h3><UButton type="button" color="neutral" variant="outline" icon="i-lucide-plus" :disabled="editor.locked.value || editor.draft.mcp.length >= 8" @click="editor.addMcp">Add connection</UButton></div>
    <p class="page-note">Save a trusted server, discover its tools, then grant each tool you want models to use. Adding a connection grants no tools.</p>
    <p v-if="!editor.draft.mcp.length" class="empty-copy">No MCP connections. Models cannot call an external MCP server.</p>
    <section v-for="(connection, index) in editor.draft.mcp" :key="index" class="mcp-connection" :aria-labelledby="`mcp-title-${index}`">
      <div class="section-heading"><h4 :id="`mcp-title-${index}`">{{ connection.name || 'New MCP connection' }}</h4><UButton type="button" color="neutral" variant="ghost" icon="i-lucide-trash-2" :aria-label="`Remove MCP connection ${connection.name || index + 1}`" :disabled="editor.locked.value" @click="editor.draft.mcp.splice(index, 1)">Remove</UButton></div>
      <div class="connection-fields">
        <div><label :for="`mcp-name-${index}`">Connection name</label><UInput :id="`mcp-name-${index}`" v-model="connection.name" required maxlength="100" class="w-full" /></div>
        <div><label :for="`mcp-id-${index}`">Connection ID</label><UInput :id="`mcp-id-${index}`" v-model="connection.id" :readonly="!!editor.savedConnection(connection.id)" required maxlength="64" class="w-full" /></div>
        <div><label :for="`mcp-transport-${index}`">Connection type</label><USelect :id="`mcp-transport-${index}`" v-model="connection.transport" :items="transports" class="w-full" /></div>
      </div>
      <template v-if="connection.transport === 'stdio'">
        <label :for="`mcp-command-${index}`">Server executable · absolute path</label><UInput :id="`mcp-command-${index}`" v-model="connection.command" required placeholder="/absolute/path/to/mcp-server" class="w-full" />
        <label :for="`mcp-args-${index}`">Fixed arguments · JSON array</label><UTextarea :id="`mcp-args-${index}`" v-model="connection.arguments" :rows="2" placeholder='["--project", "/path/to/project"]' class="w-full" />
        <p class="authority-note">Discovering tools starts this process as the worker’s account. It can access that account’s files and network independently of the file-tool grant.</p>
        <label :for="`mcp-chat-${index}`">Working directory in chat</label><USelect :id="`mcp-chat-${index}`" v-model="connection.chatDirectory" :items="editor.chatDirectories(connection.chatDirectory)" class="w-full" :aria-describedby="`mcp-chat-help-${index}`" />
        <p :id="`mcp-chat-help-${index}`" :class="connection.chatDirectory === 'workspace' ? 'page-note' : 'authority-note'">{{ connection.chatDirectory === 'workspace' ? 'Chat has no task worktree, so this server starts in an empty private folder without project files. Tasks always use their task worktree.' : 'Chat and discovery start this server in the live repository checkout, not an isolated worktree. A writing tool can change your working tree. Tasks still use their task worktree.' }}</p>
      </template>
      <template v-else>
        <label :for="`mcp-url-${index}`">MCP server address</label><UInput :id="`mcp-url-${index}`" v-model="connection.url" type="url" required placeholder="https://tools.example.com/mcp" class="w-full" />
        <p class="authority-note">Use HTTPS for remote servers; local servers may use HTTP. Granted calls send their arguments to this server, whose permissions determine what its tools can access.</p>
      </template>
      <template v-if="connection.transport === 'stdio'"><label :for="`mcp-secret-env-${index}`">Secret environment variable · needed only with a secret</label><UInput :id="`mcp-secret-env-${index}`" v-model="connection.secretEnv" maxlength="80" placeholder="MCP_AUTH_TOKEN" class="w-full" /></template>
      <label :for="`mcp-secret-${index}`">{{ connection.transport === 'http' ? 'Bearer token · optional' : 'Secret value · optional' }}</label>
      <UInput :id="`mcp-secret-${index}`" v-model="connection.secret" type="password" autocomplete="new-password" :disabled="connection.clearSecret" :placeholder="editor.savedConnection(connection.id)?.hasSecret && !editor.destinationChanged(connection) ? 'Secret saved · leave blank to keep' : 'No secret saved'" class="w-full" />
      <label v-if="editor.savedConnection(connection.id)?.hasSecret" class="check-label"><input v-model="connection.clearSecret" type="checkbox" :disabled="!!connection.secret"> Remove saved secret</label>
      <p v-if="editor.destinationChanged(connection)" class="connection-change" role="status">Changing the server destination clears its saved secret and tool grants. Save, discover tools and review access again. Enter a replacement secret above if needed.</p>
      <label :for="`mcp-timeout-${index}`">Timeout override · seconds, optional</label><UInput :id="`mcp-timeout-${index}`" v-model.number="connection.timeoutSeconds" type="number" min="1" :max="connection.transport === 'http' ? toolLimitSeconds.httpMcpMax : toolLimitSeconds.mcpMax" step="0.001" placeholder="Default: 30 seconds" class="w-full timeout-input" :aria-describedby="`mcp-timeout-help-${index}`" />
      <p :id="`mcp-timeout-help-${index}`" class="page-note">{{ editor.timeoutNote(connection.timeoutSeconds, 'mcp') }} Maximum override: {{ connection.transport === 'http' ? toolLimitSeconds.httpMcpMax : toolLimitSeconds.mcpMax }} seconds.</p>
      <label class="check-label enable-connection"><input v-model="connection.enabled" type="checkbox"> Enable this connection for granted model tools</label>
      <div class="discovery-actions">
        <UButton type="button" color="neutral" variant="outline" icon="i-lucide-search" :loading="editor.draft.discovering === connection.id" :disabled="!editor.canDiscover.value || !editor.savedConnection(connection.id)" @click="editor.discover(connection.id)">Discover tools</UButton>
        <p class="page-note">{{ editor.dirty.value ? 'Save your changes before discovering tools.' : 'Discovery contacts the saved server. It does not grant newly found tools.' }}</p>
      </div>
      <template v-if="!editor.destinationChanged(connection)">
        <fieldset v-if="tools(connection.id).length" class="tool-grants"><legend>Tools models may call</legend>
          <label v-for="tool in tools(connection.id)" :key="tool.name" class="tool-grant"><input v-model="connection.allowedTools" type="checkbox" :value="tool.name"><span><strong>{{ tool.name }}</strong><span>{{ tool.description || 'This server provides no description.' }}</span></span></label>
        </fieldset>
        <p v-else class="page-note">No discovered tools. Save this connection, then discover its catalog.</p>
      </template>
    </section>
  </section>
</template>
<style scoped>
h3, h4 { margin: 0; color: var(--ui-text-highlighted); font-weight: 650; }
h3 { font-size: 1rem; } h4 { font-size: .9375rem; overflow-wrap: anywhere; }
.section-heading { flex-wrap: wrap; gap: 12px; }
.mcp-connection { margin-top: 20px; padding: 20px; border: 1px solid var(--ui-border); border-radius: 10px; min-width: 0; display: grid; gap: 10px; }
.connection-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.connection-fields > div { display: grid; gap: 8px; min-width: 0; }
.timeout-input { max-width: 16rem; }
label, legend { font-size: .8125rem; font-weight: 600; color: var(--ui-text-highlighted); }
.check-label { min-height: 44px; font-weight: 500; gap: 10px; }
.authority-note, .connection-change { font-size: .8125rem; line-height: 1.6; padding: 12px; background: var(--ui-bg-elevated); border-left: 2px solid var(--ui-border-accented); margin: 2px 0 10px; overflow-wrap: anywhere; }
.discovery-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.discovery-actions p { flex: 1 1 220px; margin: 0; }
.tool-grants { border: 0; padding: 12px 0 0; min-width: 0; }
.tool-grants legend { padding: 0; }
.tool-grant { display: flex; gap: 12px; align-items: start; padding: 14px 0; border-bottom: 1px solid var(--ui-border); }
.tool-grant input { margin-top: 4px; flex-shrink: 0; }
.tool-grant span { display: grid; gap: 4px; overflow-wrap: anywhere; }
.tool-grant span span { font-weight: 400; color: var(--ui-text-muted); line-height: 1.5; }
.empty-copy { color: var(--ui-text-muted); font-size: .875rem; margin: 20px 0; }
input[type=checkbox] { width: 20px; height: 20px; min-height: 20px; flex: 0 0 20px; accent-color: var(--ui-primary); }
:deep(input:not([type=checkbox])), :deep(button) { min-height: 44px; }
@media (max-width: 620px) { .connection-fields { grid-template-columns: minmax(0, 1fr); } .mcp-connection { padding: 14px; } }
</style>
