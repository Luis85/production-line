import test from 'node:test';
import assert from 'node:assert/strict';
import { groupKanbanTasks, kanbanTaskKey } from '../../../src/shared/webview/task-kanban.ts';
const columns = [{ id: 'queued', label: 'Queued', statuses: ['queued'] }, { id: 'active', label: 'Executing', statuses: ['running', 'checks'] }];
test('shared Kanban keeps identical task IDs from different lines and deduplicates only exact source identity', () => {
  const a = { id: 'same-task', sourceId: 'line-a', title: 'A', status: 'queued' }, b = { ...a, sourceId: 'line-b', title: 'B' }, latest = { ...a, title: 'A latest' };
  const groups = groupKanbanTasks([a, b, latest], columns); assert.notEqual(kanbanTaskKey(a), kanbanTaskKey(b)); assert.equal(groups[0].tasks.length, 2); assert.equal(groups[0].tasks.find(task => task.sourceId === 'line-a').title, 'A latest'); assert.equal(groups[0].tasks.find(task => task.sourceId === 'line-b').title, 'B');
});
test('shared Kanban retains unknown backend states and never turns them into a different lifecycle phase', () => {
  const task = { id: 'unknown', title: 'Future state', status: 'provider_waiting_future' }; const groups = groupKanbanTasks([task], columns), other = groups.find(group => group.id === '__unmapped__'); assert.equal(other.tasks[0], task); assert.deepEqual(other.statuses, [task.status]); assert.equal(groups.flatMap(group => group.tasks).length, 1);
});
test('shared Kanban counts only supplied scope rows and assigns overlapping mappings once', () => {
  const tasks = [{ id: 'one', title: 'Visible scope', status: 'running' }], overlapping = [...columns, { id: 'duplicate', label: 'Alias', statuses: ['running'] }]; const groups = groupKanbanTasks(tasks, overlapping); assert.equal(groups.reduce((total, group) => total + group.tasks.length, 0), 1); assert.equal(groups.find(group => group.id === 'active').tasks.length, 1); assert.equal(groups.find(group => group.id === 'duplicate').tasks.length, 0); assert.equal(tasks.length, 1);
});
