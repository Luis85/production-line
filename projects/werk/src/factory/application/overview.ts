import type { Factory, FactoryOverview, LineOverview, OrchestratorOverview } from '../../shared/factory.js';

/** Resolve logical descendants once, without repeated whole-registry scans. */
export function descendantFactories(factories: readonly Factory[], rootId?: string): Factory[] {
    if (rootId === undefined) return [...factories];
    const children = new Map<string, string[]>();
    for (const factory of factories) {
        if (factory.parentId === null) continue;
        const siblings = children.get(factory.parentId) ?? [];
        siblings.push(factory.id);
        children.set(factory.parentId, siblings);
    }
    const included = new Set<string>();
    const pending = [rootId];
    while (pending.length) {
        const id = pending.pop()!;
        if (included.has(id)) continue;
        included.add(id);
        pending.push(...(children.get(id) ?? []));
    }
    return factories.filter(factory => included.has(factory.id));
}

/** Available subtotals never manufacture zero measurements for unreachable lines. */
export function overviewTotals(lines: readonly LineOverview[]): FactoryOverview['totals'] {
    const available = lines.flatMap(line => line.status === 'available' && line.overview ? [line.overview] : []);
    const sum = <K extends 'tasks' | 'workers' | 'snapshots'>(key: K): OrchestratorOverview[K] | null => {
        if (!available.length) return null;
        const result = { ...available[0][key], ...(key === 'tasks' && available.some(item => item.tasks.review !== undefined) ? { review: 0 } : {}) };
        for (const name of Object.keys(result) as (keyof typeof result)[]) {
            let total = 0;
            for (const item of available) {
                total += Number((item[key] as unknown as Record<string, number | undefined>)[String(name)] ?? 0);
                // Valid individual counters can still overflow when multiple lines are combined.
                if (!Number.isSafeInteger(total)) return null;
            }
            result[name] = total as typeof result[typeof name];
        }
        return result;
    };
    const tasks = sum('tasks'), workers = sum('workers'), snapshots = sum('snapshots');
    const overflow = available.length > 0 && (tasks === null || workers === null || snapshots === null);
    return {
        lines: lines.length,
        availableLines: available.length,
        unavailableLines: lines.length - available.length,
        partial: available.length < lines.length || overflow,
        tasks, workers, snapshots,
        cost: { amountUsd: null, reason: 'Subscription cost and provider usage are not reported by line overviews' },
    };
}
