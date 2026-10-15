<script setup lang="ts">
import type { ProviderId } from '../../infrastructure/providers';
import { computed, ref, watch } from 'vue';
import UButton from '@nuxt/ui/components/Button.vue';
import UInput from '@nuxt/ui/components/Input.vue';
import USelect from '@nuxt/ui/components/Select.vue';
import { state, workspaceAction, request, date } from '../store';
defineProps<{ providerOnly?: boolean }>();
let connectionGeneration = 0;
const check = ref<{ message: string; authentication: string; checkedAt: string } | null>(null), checking = ref(false), copied = ref(false);
const provider = ref<ProviderId>('codex-cli'), executable = ref(''), model = ref(''), key = ref(''), clearKey = ref(false), url = ref(''), enrollment = ref(''), busy = ref(false), message = ref('');
const providerNotice = ref(''), connectionNotice = ref('');
const providerBaseline = ref({ executable: '', model: '' }), connectionBaseline = ref('');
const selected = computed(() => state.settings?.providers.find(item => item.id === provider.value));
const editingLocked = computed(() => busy.value || checking.value);
const dirty = computed(() => executable.value !== providerBaseline.value.executable || model.value !== providerBaseline.value.model || !!key.value || clearKey.value);
const connectionDirty = computed(() => url.value !== connectionBaseline.value || !!enrollment.value);
function fillProvider() {
  executable.value = selected.value?.executable ?? ''; model.value = selected.value?.model ?? '';
  providerBaseline.value = { executable: executable.value, model: model.value };
  key.value = ''; clearKey.value = false; providerNotice.value = ''; check.value = null;
}
function fillConnection() { url.value = state.settings?.connection.url ?? ''; connectionBaseline.value = url.value; enrollment.value = ''; connectionNotice.value = ''; }
watch([executable, model, key, clearKey], () => { connectionGeneration++; check.value = null; }, { flush: 'sync' });
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
async function copyLogin() { try { await navigator.clipboard.writeText(provider.value === 'codex-cli' ? 'codex login' : 'claude auth login'); copied.value = true; } catch { message.value = 'Select the command below to copy it.'; } }
watch(() => state.unlocked, value => {
  if (value) { fillProvider(); fillConnection(); }
  else { connectionGeneration++; key.value = ''; enrollment.value = ''; executable.value = ''; model.value = ''; url.value = ''; message.value = ''; providerNotice.value = ''; connectionNotice.value = ''; check.value = null; }
}, { immediate: true });
const providerInput = () => JSON.stringify([provider.value, executable.value, model.value, key.value, clearKey.value]);
const connectionInput = () => JSON.stringify([url.value, enrollment.value]);
async function save(body: unknown) {
  if (editingLocked.value || !state.unlocked) return;
  const submitted = structuredClone(body) as { provider?: unknown; connection?: unknown };
  const providerSnapshot = providerInput(), connectionSnapshot = connectionInput();
  busy.value = true; message.value = '';
  try {
    if (await workspaceAction('/api/settings', submitted) && state.unlocked) {
      connectionGeneration++; check.value = null;
      // Only clear the credentials in the acknowledged form; preserve any subsequent edits.
      if (submitted.provider && providerInput() === providerSnapshot) fillProvider();
      if (submitted.connection && connectionInput() === connectionSnapshot) fillConnection();
      message.value = 'Settings saved.';
    }
  } finally { busy.value = false; }
}
</script>
<template>
  <section v-if="state.unlocked" class="monitor-section">
    <h2 v-if="!providerOnly">
      Connections
    </h2>
    <div class="settings-grid" :class="{ 'provider-only': providerOnly }">
      <form class="settings-form" @submit.prevent="save({ provider: { id: provider, executable, model, apiKey: key, clearApiKey: clearKey } })">
        <h3>
          Model provider
        </h3>
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
        <template v-if="provider.endsWith('-cli')">
          <label for="provider-path">
            CLI executable on this machine
          </label>
          <UInput id="provider-path" v-model="executable" placeholder="/absolute/path/to/codex" class="w-full" :disabled="editingLocked" />
          <p class="page-note">
            Uses the worker process owner’s existing CLI login. Sign in on the machine first. After saving, check sign-in below. Subscription quota and model access are not verified by this check. Claude Code CLI supports Linux, macOS and Windows; Codex CLI requires Linux or macOS. See the <a href="https://github.com/Luis85/production-line/blob/main/projects/werk/docs/how-to/use-worker-webview.md#connect-claude-or-codex" target="_blank" rel="noopener noreferrer">Windows Claude requirements</a>.
          </p>
          <div class="provider-login">
            <strong>
              Sign in on the worker machine
            </strong>
            <p>
              Run this command as the same user that runs the worker:
            </p>
            <div class="actions">
              <code>
                {{ provider === 'codex-cli' ? 'codex login' : 'claude auth login' }}
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
        <template v-else>
          <label for="provider-model">
            Model ID
          </label>
          <UInput id="provider-model" v-model="model" required placeholder="An available model from your provider" class="w-full" :disabled="editingLocked" />
          <label for="provider-key">
            API key
          </label>
          <UInput id="provider-key" v-model="key" type="password" autocomplete="off" :placeholder="selected?.hasApiKey ? 'Key saved · leave blank to keep' : 'Paste provider API key'" class="w-full" :disabled="editingLocked" />
          <label class="check-label">
            <input v-model="clearKey" type="checkbox" :disabled="editingLocked">
            Remove saved API key
          </label>
          <p class="page-note">
            Keys are stored privately on the worker machine and are never returned to the browser. API calls use your provider billing.
          </p>
        </template>
        <div class="actions">
          <UButton type="submit" :loading="busy" :disabled="editingLocked">
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
      </form>
      <form v-if="!providerOnly" class="settings-form" @submit.prevent="save({ connection: { enabled: true, url, enrollmentToken: enrollment } })">
        <h3>
          Optional orchestrator
        </h3>
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
