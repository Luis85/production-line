import type { DatabaseSync } from 'node:sqlite';
import { identifier, profiles, workerPolicy } from '../../shared/contracts.js';
import { DomainError } from '../../shared/errors.js';
import type { RegisteredCapabilities } from '../../shared/capabilities.js';
import type { WorkerDetail } from '../../shared/protocol.js';

/** Use bounded projections; neither registry size nor task payloads determine response size. */
export function registeredCapabilities(db: DatabaseSync, project: string, now = Date.now(), ttl = 60000): RegisteredCapabilities {
    const rows = db.prepare("SELECT DISTINCT json_extract(p.value,'$.id') AS id,json_extract(p.value,'$.provider') AS provider,COALESCE(json_extract(p.value,'$.mode'),'mock') AS mode FROM workers w,json_each(w.profiles) p WHERE w.project=? ORDER BY id,provider,mode LIMIT 65").all(project) as { id: string; provider: 'claude' | 'codex'; mode: 'mock' | 'cli' }[];
    const providers = db.prepare("SELECT DISTINCT json_extract(p.value,'$.provider') AS provider FROM workers w,json_each(w.profiles) p WHERE w.project=? ORDER BY provider LIMIT 3").all(project) as { provider: 'claude' | 'codex' }[];
    const capacity = new Map<string, { provider: 'claude' | 'codex'; mode: 'mock' | 'cli'; slotsAvailable: number }>();
    for (const row of db.prepare('SELECT id,profiles,config FROM workers WHERE project=? AND seen>?').iterate(project, now - ttl)) {
        const workerProfiles = profiles(JSON.parse(String(row.profiles))), config = workerPolicy(JSON.parse(String(row.config)));
        const active = db.prepare("SELECT profile,COUNT(*) AS busy FROM tasks WHERE worker=? AND status='running' GROUP BY profile").all(row.id);
        const machineFree = Math.max(0, config.maxParallel - active.reduce((sum, entry) => sum + Number(entry.busy), 0));
        const grouped = new Map<string, number>();
        for (const profile of workerProfiles) {
            const key = profile.provider + ':' + profile.mode;
            const free = Math.max(0, (profile.maxParallel ?? 1) - Number(active.find(entry => entry.profile === profile.id)?.busy ?? 0));
            grouped.set(key, (grouped.get(key) ?? 0) + free);
            if (!capacity.has(key)) capacity.set(key, { provider: profile.provider, mode: profile.mode, slotsAvailable: 0 });
        }
        for (const [key, free] of grouped) capacity.get(key)!.slotsAvailable += Math.min(machineFree, free);
    }
    return { eligibleCapacity: [...capacity.values()], providers: providers.map(row => row.provider), profiles: rows.slice(0, 64).map(row => ({ id: row.id, provider: row.provider, mode: row.mode })), profilesTruncated: rows.length > 64 };
}
export function workerDetail(db: DatabaseSync, project: string, id: string, now: number, ttl: number): WorkerDetail {
    const row = db.prepare('SELECT id,project,profiles,seen,config FROM workers WHERE id=? AND project=?').get(identifier(id, 'worker ID'), project) as { id: string; project: string; profiles: string; seen: number; config: string } | undefined;
    if (!row) throw new DomainError('not_found', 'Worker not found');
    const policy = workerPolicy(JSON.parse(row.config));
    const active = db.prepare("SELECT id,status,attempt,expires AS expiresAt,profile FROM tasks WHERE worker=? AND status='running' AND json_extract(payload,'$.project')=? ORDER BY created,id LIMIT 9").all(row.id, project) as WorkerDetail['activeTasks'];
    return { id: row.id, project: row.project, profiles: profiles(JSON.parse(row.profiles)), seen: row.seen, online: now - row.seen < ttl,
        config: { maxParallel: policy.maxParallel, order: policy.order, maxAttempts: policy.maxAttempts },
        activeTasks: active.slice(0, 8).map(task => ({ id: task.id, status: 'running', attempt: task.attempt, expiresAt: task.expiresAt, profile: task.profile })), activeTasksTruncated: active.length > 8 };
}

/** Read-only, project-scoped aggregate. Observing overdue leases does not hide them by reaping. */
export function operationalMetrics(db: DatabaseSync, project: string, now: number, ttl: number, windowSeconds: number): Record<string, number> {
    const tasks = db.prepare("SELECT COALESCE(SUM(status='queued'),0) AS queued,COALESCE(SUM(status='running'),0) AS running,COALESCE(SUM(status='blocked'),0) AS blocked,COALESCE(SUM(status='review'),0) AS review,MIN(CASE WHEN status='queued' THEN created END) AS oldest,COALESCE(SUM(status='running' AND expires<=?),0) AS expired FROM tasks WHERE json_extract(payload,'$.project')=?").get(now, project) as { queued: number; running: number; blocked: number; review: number; oldest: number | null; expired: number };
    const workers = db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(seen>?),0) AS online FROM workers WHERE project=?').get(now - ttl, project) as { total: number; online: number };
    const expirations = db.prepare("SELECT COUNT(*) AS count FROM events e JOIN tasks t ON t.id=e.task WHERE e.kind='lease_expired' AND e.at>=? AND e.at<=? AND json_extract(t.payload,'$.project')=?").get(now - windowSeconds * 1000, now, project) as { count: number };
    const failures = db.prepare("SELECT COUNT(*) AS count FROM snapshots WHERE project=? AND phase='after' AND received>=? AND received<=? AND json_extract(payload,'$.execution.outcome') IN ('failed','interrupted','timed_out')").get(project, now - windowSeconds * 1000, now) as { count: number };
    return { werk_tasks_queued: tasks.queued, werk_tasks_running: tasks.running, werk_tasks_blocked: tasks.blocked, werk_tasks_review: tasks.review, werk_queue_oldest_age_seconds: tasks.oldest === null ? 0 : Math.max(0, (now - tasks.oldest) / 1000), werk_leases_overdue: tasks.expired, werk_lease_expirations_window: expirations.count, werk_attempt_failures_window: failures.count, werk_workers_online: workers.online, werk_workers_offline: workers.total - workers.online };
}
