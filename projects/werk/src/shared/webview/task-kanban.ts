export interface KanbanTask {
  id: string;
  title: string;
  status: string;
  sourceId?: string;
  sourceLabel?: string;
  project?: string;
  priority?: string | number;
  workerLabel?: string;
  updatedAt?: string;
  gate?: { phase: string; label?: string };
  contextLabel?: string;
}
export interface KanbanColumn {
  id: string;
  label: string;
  statuses: string[];
}
export function kanbanTaskKey(task: KanbanTask): string {
  return JSON.stringify([task.sourceId ?? "", task.id]);
}
export function groupKanbanTasks(tasks: KanbanTask[], columns: KanbanColumn[]) {
  const unique = new Map<string, KanbanTask>();
  for (const task of tasks) unique.set(kanbanTaskKey(task), task);
  const groups = columns.map((column) => ({
    ...column,
    tasks: [] as KanbanTask[],
  }));
  const unmatched: KanbanTask[] = [];
  for (const task of unique.values()) {
    const group = groups.find((column) =>
      column.statuses.includes(task.status),
    );
    if (group) group.tasks.push(task);
    else unmatched.push(task);
  }
  if (unmatched.length)
    groups.push({
      id: "__unmapped__",
      label: "Other states",
      statuses: [...new Set(unmatched.map((task) => task.status))],
      tasks: unmatched,
    });
  return groups;
}
