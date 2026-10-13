import { join } from 'node:path';
import { atomicWrite, readBoundedFile } from './journal/files.js';
import type { Task } from '../../shared/contracts.js';
/** Bounded labels only; outcomes and measurements remain authoritative journal evidence. */
export class TaskIndex {
  private directory: string;
  private entries: { id: string; title: string }[] = [];
  private writing = Promise.resolve();
  constructor(directory: string) { this.directory = directory; }
  async init() {
    try {
      const value = JSON.parse(await readBoundedFile(join(this.directory, 'task-index.json'), 1048576));
      if (!Array.isArray(value) || value.length > 1000 || value.some(item => !item || typeof item.id !== 'string' || item.id.length > 100 || typeof item.title !== 'string' || item.title.length > 200)) throw Error('Invalid task history index');
      this.entries = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  title(id: string) { return this.entries.find(item => item.id === id)?.title ?? null; }
  remember(task: Task) {
    const entry = { id: task.id, title: task.title.slice(0, 200) };
    const pending = this.writing.catch(() => {}).then(async () => {
      const entries = [...this.entries.filter(item => item.id !== entry.id), entry].slice(-1000);
      await atomicWrite(join(this.directory, 'task-index.json'), JSON.stringify(entries) + '\n');
      this.entries = entries;
    });
    this.writing = pending; this.writing.catch(() => {}); return pending;
  }
}
