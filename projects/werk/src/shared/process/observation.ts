import { AsyncLocalStorage } from 'node:async_hooks';
import type { LaunchedProcess } from './launcher.js';

/** Caller-provided display metadata only; never derive it from executable, argv or environment. */
export interface ProcessPurpose { kind: string; label: string; }
export interface ObservedLaunch {
  child: LaunchedProcess; ownsProcessGroup: boolean; failed: boolean;
}
type Observer = (launch: ObservedLaunch, purpose?: ProcessPurpose) => void;
const observers = new AsyncLocalStorage<Observer>();
const launches = new WeakMap<LaunchedProcess, ObservedLaunch>();

/** Async descendants inherit exactly this observer; concurrent workspaces remain isolated. */
export function withProcessObserver<T>(observer: Observer, operation: () => T): T {
  return observers.run(observer, operation);
}
export function observeProcessLaunch(child: LaunchedProcess, ownsProcessGroup: boolean, purpose?: ProcessPurpose): void {
  const observer = observers.getStore();
  if (!observer) return;
  const launch: ObservedLaunch = { child, ownsProcessGroup, failed: false };
  launches.set(child, launch);
  try { observer(launch, purpose); } catch { /* Observation must never alter process execution. */ }
}
/** Record deadline/cancellation/output failures even when the child handles SIGTERM with exit 0. */
export function observeProcessFailure(child: LaunchedProcess): void {
  const launch = launches.get(child);
  if (launch) launch.failed = true;
}
