<script lang="ts">
import { reactive, watch as watchPrivateDrafts } from "vue";
import { state as privateWorkerState } from "../store";
import type { GatePolicy } from "../../application/request-gates";
const privatePolicy = reactive({
  text: "",
  baseRevision: null as number | null,
  baseText: "",
  pending: null as {
    action: "set_policy";
    policy: GatePolicy;
    expectedRevision: number;
    operationId: string;
  } | null,
});
watchPrivateDrafts(
  () => privateWorkerState.draftEpoch,
  () => {
    Object.assign(privatePolicy, {
      text: "",
      baseRevision: null,
      baseText: "",
      pending: null,
    });
  },
  { flush: "sync" },
);
</script>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import UButton from "@nuxt/ui/components/Button.vue";
import UTextarea from "@nuxt/ui/components/Textarea.vue";
import UAlert from "@nuxt/ui/components/Alert.vue";
import { request, state } from "../store";
interface PolicyView {
  schemaVersion: 1;
  revision: number;
  policy: GatePolicy;
  digest: string;
}
const view = ref<PolicyView | null>(null),
  loading = ref(false),
  busy = ref(false),
  error = ref(""),
  notice = ref("");
let generation = 0;
const dirty = computed(() => privatePolicy.text !== privatePolicy.baseText);
async function load(discardDraft = false) {
  if (!state.unlocked || loading.value || busy.value) return;
  const current = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const result: PolicyView = await request("/api/requests", "POST", {
      action: "policy",
    });
    if (current !== generation || !state.unlocked) return;
    view.value = result;
    if (discardDraft || privatePolicy.baseRevision === null || !dirty.value) {
      const text = JSON.stringify(result.policy, null, 2);
      Object.assign(privatePolicy, {
        text,
        baseText: text,
        baseRevision: result.revision,
      });
    }
  } catch (failure) {
    if (current === generation && state.unlocked)
      error.value = (failure as Error).message;
  } finally {
    if (current === generation) loading.value = false;
  }
}
async function save() {
  if (
    !state.unlocked ||
    busy.value ||
    loading.value ||
    privatePolicy.pending ||
    privatePolicy.baseRevision === null ||
    !dirty.value
  )
    return;
  error.value = "";
  notice.value = "";
  try {
    if (new TextEncoder().encode(privatePolicy.text).length > 65536)
      throw Error("Gate policy exceeds 64 KiB. Reduce the JSON before saving.");
    const value: unknown = JSON.parse(privatePolicy.text);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as { schemaVersion?: unknown }).schemaVersion !== 1
    )
      throw Error("Use a gate policy object with schemaVersion: 1.");
    privatePolicy.pending = {
      action: "set_policy",
      policy: value as GatePolicy,
      expectedRevision: privatePolicy.baseRevision,
      operationId: crypto.randomUUID(),
    };
    await send();
  } catch (failure) {
    error.value =
      failure instanceof SyntaxError
        ? "Policy JSON is invalid. Correct it before saving."
        : (failure as Error).message;
  }
}
async function send() {
  if (!state.unlocked || busy.value || !privatePolicy.pending) return;
  const command = privatePolicy.pending,
    current = generation;
  busy.value = true;
  error.value = "";
  try {
    const result: PolicyView = await request("/api/requests", "POST", command);
    if (privatePolicy.pending?.operationId === command.operationId)
      privatePolicy.pending = null;
    if (current !== generation || !state.unlocked) return;
    view.value = result;
    const text = JSON.stringify(result.policy, null, 2);
    Object.assign(privatePolicy, {
      text,
      baseText: text,
      baseRevision: result.revision,
    });
    notice.value =
      "Policy saved for future requests. Existing requests retain their frozen policy.";
  } catch (failure) {
    if (current !== generation || !state.unlocked) return;
    const status = (failure as Error & { status?: number }).status;
    if (status && status >= 400 && status < 500 && status !== 401)
      privatePolicy.pending = null;
    error.value = (failure as Error).message;
  } finally {
    if (current === generation) busy.value = false;
  }
}
watch(
  () => state.unlocked,
  (value) => {
    generation++;
    loading.value = false;
    busy.value = false;
    view.value = null;
    if (value) void load();
  },
);
onMounted(() => {
  void load();
});
onBeforeUnmount(() => {
  generation++;
});
</script>
<template>
  <section class="request-policy" aria-labelledby="request-policy-title">
    <h2 id="request-policy-title">Request gate policy</h2>
    <p>
      Ready and done checks use bounded JSON rules. Unknown evidence fails
      closed. Saving changes only future admissions; every accepted request
      retains its policy and digest.
    </p>
    <UAlert v-if="error" color="error" variant="subtle" :description="error" />
    <p v-if="notice" role="status">{{ notice }}</p>
    <div class="policy-actions">
      <UButton
        variant="outline"
        :loading="loading"
        :disabled="busy"
        @click="load()"
        >Inspect current policy</UButton
      ><UButton
        v-if="dirty && view && view.revision !== privatePolicy.baseRevision"
        variant="outline"
        :disabled="busy || loading || !!privatePolicy.pending"
        @click="load(true)"
        >Replace draft with current policy</UButton
      >
    </div>
    <details v-if="view || privatePolicy.baseRevision !== null">
      <summary>
        Policy JSON · draft based on revision {{ privatePolicy.baseRevision
        }}{{ dirty ? " · unsaved changes" : "" }}
      </summary>
      <p
        v-if="view && view.revision !== privatePolicy.baseRevision"
        role="status"
      >
        Worker policy changed to revision {{ view.revision }}. Your draft is
        preserved; saving against its older revision will be rejected.
      </p>
      <form @submit.prevent="save">
        <label for="request-policy-json">Future-admission policy JSON</label
        ><UTextarea
          id="request-policy-json"
          v-model="privatePolicy.text"
          :rows="18"
          :disabled="busy || !!privatePolicy.pending"
          spellcheck="false"
          class="policy-json"
        />
        <p>
          The server validates allowed facts, comparison types and attempt
          bounds. JSON cannot grant tools, alter model credentials or bypass
          worker admission.
        </p>
        <UButton
          type="submit"
          :loading="busy"
          :disabled="!dirty || loading || !!privatePolicy.pending"
          >Save future-admission policy</UButton
        >
      </form>
    </details>
    <div v-if="privatePolicy.pending" class="policy-pending">
      <p>
        The acknowledgement is uncertain. Retry the same operation; your JSON
        and revision are retained.
      </p>
      <UButton variant="outline" :loading="busy" @click="send"
        >Retry same policy operation</UButton
      >
    </div>
  </section>
</template>
<style scoped>
.request-policy {
  display: grid;
  gap: 16px;
  padding-block: 24px;
  border-top: 1px solid var(--line, #3b4b56);
  min-width: 0;
}
.request-policy h2 {
  margin: 0;
  font-size: 18px;
}
.request-policy p {
  margin: 0;
  max-width: 75ch;
  color: var(--muted, #b5c4cd);
}
.policy-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
summary {
  min-height: 44px;
  cursor: pointer;
  padding-block: 12px;
  font-weight: 600;
}
form {
  display: grid;
  gap: 16px;
  margin-top: 16px;
  min-width: 0;
}
form > button {
  justify-self: start;
}
label {
  font-weight: 600;
  font-size: 14px;
}
.policy-json :deep(textarea) {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 13px;
  min-width: 0;
}
.policy-pending {
  display: grid;
  gap: 12px;
}
.policy-pending > button {
  justify-self: start;
}
</style>
