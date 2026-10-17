import { useRoute, useRouter } from 'vue-router';
import { computed, nextTick, ref, watch, onActivated } from 'vue';
import { state, date, workspaceAction, taskStatus } from '../store';

/** Filters saved conversations and restores their task context when opened. */
export function useTaskConversationHistory() {
  const route = useRoute(), router = useRouter(), opening = ref('');
  const chatSearch = ref(''), chatStatus = ref('all'), chatArchive = ref('active'), taskKind = ref('all');
  const taskKindOptions = [{ label: 'All task types', value: 'all' }, { label: 'Chat tasks', value: 'chat' }, { label: 'File tasks', value: 'local' }, { label: 'Assigned tasks', value: 'orchestrator' }];
  const kindLabel = (kind: string) => kind === 'local' ? 'File task' : kind === 'orchestrator' ? 'Assigned task' : 'Chat task';
  watch(() => route.query.taskState, value => { chatStatus.value = value === 'failed' ? 'failed' : value === 'attention' ? 'attention' : 'all'; chatSearch.value = ''; taskKind.value = 'all'; chatArchive.value = 'active'; }, { immediate: true });
  async function focusTaskConversations() {
    const shouldFocus = () => state.unlocked && route.path === '/history' && ['failed', 'attention'].includes(String(route.query.taskState)) && !['review', 'failed'].includes(String(route.query.fileState));
    if (!shouldFocus()) return;
    await nextTick();
    if (!shouldFocus()) return;
    const heading = document.getElementById('chat-history-title');
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'start' });
  }
  onActivated(() => { void focusTaskConversations(); });
  watch(() => route.query.taskState, () => { void focusTaskConversations(); });
  const chatStatusOptions = [{ label: 'All states', value: 'all' }, { label: 'Needs your input', value: 'attention' }, ...['draft', 'queued', 'running', 'waiting_input', 'escalated', 'completed', 'failed', 'cancelled', 'interrupted'].map(value => ({ label: taskStatus(value), value }))];
  const chatArchiveOptions = [{ label: 'Active tasks', value: 'active' }, { label: 'Archived tasks', value: 'archived' }, { label: 'All tasks', value: 'all' }];
  const allChatTasks = computed(() => state.sessions?.records ?? []);
  const chatTasks = computed(() => allChatTasks.value.filter(item =>
    (taskKind.value === 'all' || item.kind === taskKind.value) &&
    (chatStatus.value === 'all' || chatStatus.value === 'attention' && ['waiting_input', 'escalated'].includes(item.status) || item.status === chatStatus.value) &&
    (chatArchive.value === 'all' || item.archived === (chatArchive.value === 'archived')) &&
    [item.title, item.taskId, item.provider].join(' ').toLowerCase().includes(chatSearch.value.trim().toLowerCase())
  ).slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
  function clearChatFilters() { chatSearch.value = ''; chatStatus.value = 'all'; chatArchive.value = 'all'; taskKind.value = 'all'; }
  async function openChat(id: string) { if (opening.value) return; opening.value = id; try { if (await workspaceAction('/api/sessions', { action: 'select', id })) await router.push({ path: '/taskboard', query: { session: id } }); } finally { opening.value = ''; } }

  return {
    allChatTasks,
    chatArchive,
    chatArchiveOptions,
    chatSearch,
    chatStatus,
    chatStatusOptions,
    chatTasks,
    clearChatFilters,
    date,
    kindLabel,
    openChat,
    opening,
    state,
    taskKind,
    taskKindOptions,
    taskStatus,
  };
}
