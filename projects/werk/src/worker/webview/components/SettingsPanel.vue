<script setup lang="ts">
import type { ProviderId } from '../../application/provider-contract';
import type { ProviderAuthenticationMode, ProviderCapabilities } from '../../application/provider-capabilities';
import type { ModelEffort } from '../../application/model-effort';
import { computed, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import ModelSelectionFields from './ModelSelectionFields.vue';
import ProviderAccountPanel from './ProviderAccountPanel.vue';
import ProviderCapabilitiesPanel from './ProviderCapabilitiesPanel.vue';
import { state, workspaceAction, request, date } from '../store';
defineProps<{ providerOnly?: boolean; connectionOnly?: boolean }>();
let connectionGeneration = 0;
const check = ref<{ message: string; authentication: string; checkedAt: string; version?: string | null; capabilities?: ProviderCapabilities } | null>(null), checking = ref(false), copied = ref(false);
const provider = ref<ProviderId>('codex-cli'), executable = ref(''), model = ref(''), key = ref(''), clearKey = ref(false), url = ref(''), enrollment = ref(''), busy = ref(false), message = ref('');
type AuthenticationMode = ProviderAuthenticationMode;
const authenticationMode = ref<AuthenticationMode>('legacy');
const authenticationLabels = { 'cli-account': 'Provider account / subscription', 'api-key': 'API key · metered billing', legacy: 'Choose authentication before running work' };
const providerNotice = ref(''), connectionNotice = ref(''), defaultNotice = ref('');
const effort = ref<ModelEffort | ''>('default'), defaultProvider = ref<ProviderId>('codex-cli'), defaultBaseline = ref<ProviderId>('codex-cli');
const defaultDirty = computed(() => defaultProvider.value !== defaultBaseline.value);
const loginCommand = computed(() => provider.value === 'codex-cli' ? 'codex login' : provider.value === 'cursor-cli' ? 'agent login' : 'claude auth login');
const providerBaseline = ref({ executable: '', model: '', effort: 'default' as ModelEffort | '', authenticationMode: 'legacy' as AuthenticationMode }), connectionBaseline = ref('');
const selected = computed(() => state.settings?.providers.find(item => item.id === provider.value));
const authenticationOptions = computed<Array<{ value: AuthenticationMode; label: string; disabled?: boolean }>>(() => [
  ...(authenticationMode.value === 'legacy' ? [{ value: 'legacy' as const, label: authenticationLabels.legacy, disabled: true }] : []),
  ...(selected.value?.supportedAuthenticationModes ?? (provider.value.endsWith('-cli') ? ['cli-account', 'api-key'] as const : ['api-key'] as const)).map(value => ({ value, label: authenticationLabels[value] })),
]);
const accountRevision = ref(0);
const accountConnectionKey = computed(() => JSON.stringify([selected.value?.executable ?? '', selected.value?.authenticationMode, !!selected.value?.hasApiKey, accountRevision.value]));
const providerCommand = () => ({ provider: { id: provider.value, executable: executable.value, model: model.value, effort: effort.value || 'default', authenticationMode: authenticationMode.value, apiKey: key.value, clearApiKey: clearKey.value } });
const editingLocked = computed(() => busy.value || checking.value);
const dirty = computed(() => executable.value !== providerBaseline.value.executable || model.value !== providerBaseline.value.model || effort.value !== providerBaseline.value.effort || authenticationMode.value !== providerBaseline.value.authenticationMode || !!key.value || clearKey.value);
const connectionDirty = computed(() => url.value !== connectionBaseline.value || !!enrollment.value);
function fillProvider() {
  executable.value = selected.value?.executable ?? ''; model.value = selected.value?.model ?? ''; effort.value = selected.value?.effort ?? 'default';
  authenticationMode.value = selected.value?.authenticationMode ?? (provider.value.endsWith('-cli') ? 'legacy' : 'api-key');
  providerBaseline.value = { executable: executable.value, model: model.value, effort: effort.value, authenticationMode: authenticationMode.value };
  key.value = ''; clearKey.value = false; providerNotice.value = ''; check.value = null;
}
function fillDefault() { defaultProvider.value = state.settings?.defaultProvider ?? 'codex-cli'; defaultBaseline.value = defaultProvider.value; defaultNotice.value = ''; }
watch(() => state.settings?.defaultProvider, (value, previous) => {
  if (!state.unlocked || value === previous) return;
  if (defaultDirty.value) defaultNotice.value = 'The saved default changed elsewhere. Your choice is kept. Reload before saving.';
  else fillDefault();
}, { immediate: true });
function fillConnection() { url.value = state.settings?.connection.url ?? ''; connectionBaseline.value = url.value; enrollment.value = ''; connectionNotice.value = ''; }
watch([executable, model, effort, authenticationMode, key, clearKey], () => { connectionGeneration++; check.value = null; }, { flush: 'sync' });
watch(provider, () => { connectionGeneration++; fillProvider(); copied.value = false; }, { flush: 'sync' });
watch(() => JSON.stringify(selected.value), (value, previous) => {
  if (!state.unlocked || value === previous) return;
  connectionGeneration++; check.value = null;
  if (dirty.value) providerNotice.value = 'This saved provider changed elsewhere. Your edits are kept. Reload saved values or review your edits before saving.';
  else fillProvider();
}, { immediate: true });
watch(() => JSON.stringify(state.settings?.connection), (value, previous) => {
  if (!state.unlocked || value === previous) return;
  if (connectionDirty.value) connectionNotice.value = 'The saved orchestrator connection changed elsewhere. Your edits are kept. Reload saved values or review your edits before saving.';
  else fillConnection();
}, { immediate: true });
async function checkConnection() {
  if (editingLocked.value || dirty.value) return;
  const selectedProvider = provider.value, generation = connectionGeneration; checking.value = true;
  try { const result = await request('/api/providers/check', 'POST', { id: selectedProvider }); if (selectedProvider === provider.value && generation === connectionGeneration) check.value = result; }
  catch (error) { if (selectedProvider === provider.value && generation === connectionGeneration) check.value = { authentication: 'unknown', message: (error as Error).message, checkedAt: new Date().toISOString() }; }
  finally { checking.value = false; }
}
async function copyLogin() { try { await navigator.clipboard.writeText(loginCommand.value); copied.value = true; } catch { message.value = 'Select the command below to copy it.'; } }
watch(() => state.unlocked, value => {
  if (value) { fillProvider(); fillConnection(); fillDefault(); }
  else { connectionGeneration++; key.value = ''; enrollment.value = ''; executable.value = ''; model.value = ''; effort.value = 'default'; defaultNotice.value = ''; url.value = ''; message.value = ''; providerNotice.value = ''; connectionNotice.value = ''; check.value = null; }
}, { immediate: true });
const providerInput = () => JSON.stringify([provider.value, executable.value, model.value, effort.value, authenticationMode.value, key.value, clearKey.value]);
const connectionInput = () => JSON.stringify([url.value, enrollment.value]);
async function save(body: unknown) {
  if (editingLocked.value || !state.unlocked) return;
  const submitted = structuredClone(body) as { provider?: unknown; connection?: unknown; defaultProvider?: ProviderId };
  const providerSnapshot = providerInput(), connectionSnapshot = connectionInput(), submittedDefault = defaultProvider.value;
  busy.value = true; message.value = '';
  try {
    if (await workspaceAction('/api/settings', submitted) && state.unlocked) {
      connectionGeneration++; check.value = null;
      // Only clear the credentials in the acknowledged form; preserve any subsequent edits.
      if (submitted.provider) { accountRevision.value++; if (providerInput() === providerSnapshot) fillProvider(); }
      if (submitted.connection && connectionInput() === connectionSnapshot) fillConnection();
      if (submitted.defaultProvider && defaultProvider.value === submittedDefault) fillDefault();
      message.value = 'Settings saved.';
    }
  } finally { busy.value = false; }
}
</script>
<template>
  <section v-if="state.unlocked" class="monitor-section">
    <h2 v-if="!providerOnly && !connectionOnly">
      Connections
    </h2>
    <form v-if="!connectionOnly" class="settings-form request-defaults" @submit.prevent="save({ defaultProvider, expectedDefaultProvider: defaultBaseline })">
      <h2>New request defaults</h2>
      <label for="worker-default-provider">Default provider for new requests</label>
      <USelect id="worker-default-provider" v-model="defaultProvider" :items="state.settings?.providers.map(item => ({ label: item.label + (item.configured ? '' : ' · needs setup'), value: item.id })) ?? []" :disabled="editingLocked" class="w-full" />
      <p class="page-note">New requests start with this provider. Each provider’s model and effort defaults are set below. Accepted requests retain their saved selection.</p>
      <p v-if="defaultNotice" role="status" class="page-note">{{ defaultNotice }}</p>
      <div class="actions"><UButton type="submit" :loading="busy" :disabled="editingLocked || !defaultDirty">Save default provider</UButton><UButton v-if="defaultNotice" color="neutral" variant="outline" :disabled="editingLocked" @click="fillDefault">Reload saved default</UButton></div>
    </form>
    <div class="settings-grid" :class="{ 'provider-only': providerOnly || connectionOnly }">
      <form v-if="!connectionOnly" class="settings-form" @submit.prevent="save(providerCommand())">
        <h2>Provider connections &amp; accounts</h2>
        <div v-if="providerNotice" role="status">
          <p class="page-note">
            {{ providerNotice }}
          </p>
          <UButton color="neutral" variant="outline" :disabled="editingLocked" @click="fillProvider">
            Reload saved provider
          </UButton>
        </div>
        <label for="provider-connection">
          Connection
        </label>
        <USelect id="provider-connection" v-model="provider" :items="state.settings?.providers.map(item => ({ label: item.label, value: item.id })) ?? []" class="w-full" :disabled="editingLocked" />
        <label for="provider-authentication">Authentication and billing</label>
        <USelect id="provider-authentication" v-model="authenticationMode" :items="authenticationOptions" placeholder="Choose how this worker signs in" class="w-full" :disabled="editingLocked" aria-describedby="provider-authentication-help" />
        <p id="provider-authentication-help" class="page-note" :class="{ 'error-text': authenticationMode === 'legacy' }">
          {{ authenticationMode === 'legacy' ? 'Choose an authentication method before starting new work. This saved connection has not declared which credentials to use.' : authenticationMode === 'cli-account' ? 'Uses the provider account signed in as the worker’s operating-system user. An API key will not be used as a fallback.' : 'Uses the configured API key with provider billing. Removing the key does not switch this connection to a subscription account.' }}
        </p>
        <template v-if="provider.endsWith('-cli')">
          <label for="provider-path">
            CLI executable on this machine
          </label>
          <UInput id="provider-path" v-model="executable" placeholder="/absolute/path/to/codex" class="w-full" :disabled="editingLocked" />
          <p class="page-note">
            After saving, check the connection below. Subscription quota and model access are not verified by this check. Claude Code CLI supports Linux, macOS and Windows; Codex CLI requires Linux or macOS. See the <a href="https://github.com/Luis85/production-line/blob/main/projects/werk/docs/how-to/use-worker-webview.md#connect-claude-or-codex" target="_blank" rel="noopener noreferrer">Windows Claude requirements</a>.
          </p>
          <div v-if="authenticationMode === 'cli-account'" class="provider-login">
            <strong>
              Sign in on the worker machine
            </strong>
            <p>
              Run this command as the same user that runs the worker:
            </p>
            <div class="actions">
              <code>
                {{ loginCommand }}
              </code>
              <UButton color="neutral" variant="ghost" icon="i-lucide-copy" @click="copyLogin">
                {{ copied ? 'Copied' : 'Copy command' }}
              </UButton>
            </div>
            <p class="page-note">
              For Docker, sign in inside the worker container. A host login is not automatically available there.
            </p>
          </div>
        </template>
        <template v-if="authenticationMode === 'api-key'">
          <label for="provider-key">
            API key
          </label>
          <UInput id="provider-key" v-model="key" type="password" autocomplete="off" :placeholder="selected?.hasApiKey ? 'Key saved · leave blank to keep' : 'Paste provider API key'" class="w-full" :disabled="editingLocked" />
          <label class="check-label">
            <input v-model="clearKey" type="checkbox" :disabled="editingLocked">
            Remove saved API key
          </label>
          <p class="page-note">
            Keys are stored privately on the worker machine and are never returned to the browser. Leave blank to retain a saved key. API usage is billed by your provider.
          </p>
        </template>
        <ModelSelectionFields id="provider-default" :provider="provider" v-model:model="model" v-model:effort="effort" :providers="state.settings?.providers ?? []" :disabled="editingLocked" :show-provider="false" defaults />
        <p v-if="provider === 'cursor-cli'" class="page-note">Cursor CLI does not provide documented token or cost counts. Usage remains unknown; enabled consumption limits can hold later work until you reconcile that usage.</p>
        <div class="actions">
          <UButton type="submit" :loading="busy" :disabled="editingLocked || authenticationMode === 'legacy'">
            Save provider
          </UButton>
          <UButton color="neutral" variant="outline" :loading="checking" :disabled="editingLocked || dirty" @click="checkConnection">
            {{ provider.endsWith('-cli') ? 'Check sign-in' : 'Check connection' }}
          </UButton>
        </div>
        <p class="page-note">
          {{ dirty ? 'Save changes before checking this connection.' : 'Checks the saved connection without sending a task.' }}
        </p>
        <p v-if="check" role="status" class="provider-result" :class="{ 'error-text': ['signed-out', 'unavailable'].includes(check.authentication) }">
          {{ selected?.label }} · {{ date(check.checkedAt) }} · {{ check.message }}
        </p>
        <ProviderCapabilitiesPanel :capabilities="check?.capabilities ?? selected?.capabilities" :runtime-version="check?.version" />
        <ProviderAccountPanel v-if="provider.endsWith('-cli')" :provider-id="provider" :authentication-mode="selected?.authenticationMode" :connection-key="accountConnectionKey" :enabled="!dirty && !!selected?.configured" />
      </form>
      <form v-if="!providerOnly" class="settings-form" @submit.prevent="save({ connection: { enabled: true, url, enrollmentToken: enrollment } })">
        <h2>Optional orchestrator</h2>
        <div v-if="connectionNotice" role="status">
          <p class="page-note">
            {{ connectionNotice }}
          </p>
          <UButton color="neutral" variant="outline" :disabled="editingLocked" @click="fillConnection">
            Reload saved connection
          </UButton>
        </div>
        <p>
          {{ state.settings?.connection.enabled ? 'This worker is configured to register and accept orchestrator tasks.' : 'Standalone · chat, sessions and local tasks work without an orchestrator.' }}
        </p>
        <label for="orchestrator-url">
          Orchestrator address
        </label>
        <UInput id="orchestrator-url" v-model="url" type="url" placeholder="http://127.0.0.1:3000" required class="w-full" :disabled="editingLocked" />
        <label for="enrollment-token">
          Enrollment token
        </label>
        <UInput id="enrollment-token" v-model="enrollment" type="password" autocomplete="off" :placeholder="state.settings?.connection.hasEnrollmentToken ? 'Token saved · leave blank to keep' : 'From your orchestrator administrator'" class="w-full" :disabled="editingLocked" />
        <div class="actions">
          <UButton type="submit" :loading="busy" :disabled="editingLocked">
            Save &amp; connect
          </UButton>
          <UButton v-if="state.settings?.connection.enabled" color="neutral" variant="outline" :disabled="editingLocked" @click="save({ connection: { enabled: false } })">
            Go standalone
          </UButton>
        </div>
        <p class="page-note">
          Registration retries automatically. Pause the queue and finish assigned tasks before disconnecting. A registered identity remains bound to its original orchestrator.
        </p>
      </form>
    </div>
    <p v-if="message" role="status">
      {{ message }}
    </p>
    <p v-if="state.actionError" role="alert" class="error-text">
      {{ state.actionError }}
    </p>
  </section>
</template>

<style scoped>
.request-defaults { margin-bottom: 28px; max-width: 760px; }
.settings-grid.provider-only { grid-template-columns: minmax(0, 1fr); }
.request-defaults :deep(button[role="combobox"]) { min-height: 44px; }
</style>
