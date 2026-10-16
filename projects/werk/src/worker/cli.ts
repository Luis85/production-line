#!/usr/bin/env node
import { args, validateOptions, integer, fail } from '../shared/cli.js';
import { request } from '../shared/http/client.js';
import { runWorker } from './runner.js';
import { statusHtml } from './status/server.js';
import { configuration } from './config.js';
import { ValidationError } from '../shared/errors.js';
const help = `werk-worker — standalone worker with optional orchestrator connection

run [--url http://127.0.0.1:3000] [--state-dir .state/worker]
    [--config worker.json] [--parallel 1] [--profiles claude,codex]
    [--poll-ms 1000] [--mock-ms 3000] [--timeout-ms 60000] [--project-dir /checkout]
    [--features-dir features] [--status-host 127.0.0.1] [--status-port 4100] [--retain-acknowledged-pairs 1000]
status [--url http://127.0.0.1:4100] [--format json|html]
--help

Omit --url to start standalone. Connect later from Monitoring & Status.
Set WERK_ENROLLMENT_TOKEN on first registration; identity is persisted privately.
Set WERK_WORKER_TOKEN to 64 lowercase hexadecimal characters to configure local webview access; otherwise its persisted token is reused.
Project assignment comes from the server enrollment grant. Machine and profile concurrency are configurable; server enforces limits.
Each worker needs its own state directory and status port (0 selects a free port).
HTML: GET /, JSON: GET /status, health: GET /healthz on local status listener.
SIGINT/SIGTERM cancels execution; server requeues after lease expiry.
JSON stdout, operational logs stderr. Exit 0 success, 2 input/API 4xx, 1 other error.
Default profiles are simulated. A trusted worker config may opt into native Linux Codex execution; patches require human review.`;
try {
    const { commands, options: o } = args(), cmd = commands.join(' ');
    if (o.help || !cmd)
        console.log(help);
    else if (cmd === 'run') {
        validateOptions(o, ['url', 'state-dir', 'profiles', 'poll-ms', 'mock-ms', 'status-host', 'status-port', 'config', 'parallel', 'timeout-ms', 'project-dir', 'features-dir', 'retain-acknowledged-pairs']);
        const effective = await configuration(o);
        const stop = new AbortController();
        process.once('SIGINT', () => stop.abort());
        process.once('SIGTERM', () => stop.abort());
        await runWorker({ url: o.url ?? process.env.WERK_URL, stateDir: o['state-dir'] ?? '.state/worker', enrollmentToken: process.env.WERK_ENROLLMENT_TOKEN ?? '', webviewToken: process.env.WERK_WORKER_TOKEN, ...effective, projectDir: o['project-dir'], statusHost: o['status-host'] ?? '127.0.0.1', statusPort: integer(o['status-port'] ?? '4100', 'status-port', 0, 65535) }, stop.signal);
    }
    else if (cmd === 'status') {
        validateOptions(o, ['url', 'format']);
        const base = o.url ?? 'http://127.0.0.1:4100';
        if (!o.format || o.format === 'json')
            console.log(JSON.stringify(await request(base, '/status', '')));
        else if (o.format === 'html') {
            console.log(statusHtml(await request(base, '/status', '')));
        }
        else
            throw new ValidationError('--format must be json or html');
    }
    else
        throw new ValidationError('Unknown command. Use --help.');
}
catch (error) {
    fail(error);
}
