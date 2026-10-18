import { DomainError } from './errors.js';

                                                                                                                                                                                                         
export const defaultMonitoringThresholds                                 = Object.freeze({ queueAgeSeconds: 300, failureWindowSeconds: 900, failedAttempts: 3, outboxAgeSeconds: 120, outboxPending: 100, staleObservationSeconds: 120 });
export function monitoringThresholds(env                                    )                       {
    const result = { ...defaultMonitoringThresholds };
    const names                                             = { queueAgeSeconds: 'WERK_ALERT_QUEUE_AGE_SECONDS', failureWindowSeconds: 'WERK_ALERT_FAILURE_WINDOW_SECONDS', failedAttempts: 'WERK_ALERT_FAILED_ATTEMPTS', outboxAgeSeconds: 'WERK_ALERT_OUTBOX_AGE_SECONDS', outboxPending: 'WERK_ALERT_OUTBOX_PENDING', staleObservationSeconds: 'WERK_ALERT_STALE_OBSERVATION_SECONDS' };
    for (const key of Object.keys(names)                                  ) {
        const value = env[names[key]];
        if (value === undefined) continue;
        if (!/^[1-9][0-9]{0,7}$/.test(value) || Number(value) > 8640000) throw new DomainError('invalid_input', names[key] + ': integer 1–8640000 required');
        result[key] = Number(value);
    }
    return result;
}
                                                                                                                          
                                                                                                                                                                                                                         
export function monitoringReport(service                             , now        , metrics                        , alerts                    , thresholds                       = defaultMonitoringThresholds)                   {
    for (const [name, value] of Object.entries(metrics)) if (!/^werk_[a-z_]+$/.test(name) || !Number.isFinite(value) || value < 0) throw new Error('Invalid operational measurement');
    return { schemaVersion: 1, service, observedAt: new Date(now).toISOString(), thresholds: { ...thresholds }, metrics, alerts };
}
/** Fixed metric names, no labels, and gauges (including moving-window counts). */
export function prometheus(report                  )         {
    return Object.entries({ ...report.metrics, werk_alerts_active: report.alerts.length }).map(([name, value]) => `# TYPE ${name} gauge\n${name} ${value}\n`).join('');
}
export function operationalAlert(code        , message        , remediation        , severity                               = 'warning')                   { return { code, severity, message, remediation }; }
export function ageSeconds(now        , at               )         { return at === null ? 0 : Math.max(0, (now - at) / 1000); }
