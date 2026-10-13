#!/usr/bin/env node
import { args, validateOptions, integer, input, fail } from '../shared/cli.js';
import { request } from '../shared/http/client.js';
import { DomainError } from '../shared/errors.js';
import { identifier } from '../shared/contracts.js';
import { managedRegistryEnvironment } from './application/managed-registry.js';
import { mutationKey } from './application/mutations.js';
const help = `werk-factory — Factory hierarchy and production line registry

serve [--host 127.0.0.1] [--port 3100] [--db .state/factories.sqlite]
      [--poll-timeout-ms 3000] [--poll-concurrency 4]
factory list|get|create|update|delete [--id ID] [--file PATH|-] [--key KEY] [--url URL]
line list|get|create|update|delete [--id ID] [--file PATH|-] [--key KEY] [--url URL]
overview [--factory ID] [--url URL]
monitoring [--url URL] (read-only operational metrics and alerts)
health [--url URL]
mcp serve [--url URL] [--allow-writes true|false] (MCP stdio; read-only by default)
--help

create/update read a JSON object from --file; '-' means stdin. get/update/delete require --id.
Factory create: {"id":"products","name":"Products","parentId":null}
Line create: {"id":"alpha","name":"Alpha","factoryId":"products","orchestratorUrl":"http://localhost:3000","webviewUrl":"http://localhost:3000/","tokenEnv":"WERK_LINE_ALPHA_TOKEN"}
Use --key on create/update/delete for durable retries; reuse it only for the same operation and input.
Keys are registry-wide, 1–128 letters/digits/._:-; without a key, legacy mutation behavior applies.
Updates contain only changed fields, excluding id. Moves use parentId or factoryId.
Delete a line unregisters it only. Factories must be empty before deletion.
Use WERK_FACTORY_ADMIN_TOKEN (>=24 chars); WERK_FACTORY_URL sets the client URL.
Line credentials remain server-side environment values WERK_LINE_<NAME>_TOKEN.
JSON stdout; diagnostics stderr. Exit 0 success, 2 input/API 4xx, 1 operational failure.
This service registers and observes existing orchestrators. It does not launch or schedule work.`;
try {
    const { commands, options } = args(), command = commands.join(' ');
    if (options.help || !command)
        console.log(help);
    else if (command === 'mcp serve') {
        validateOptions(options, ['url', 'allow-writes']);
        const { serveWerkMcp } = await import('../shared/mcp/stdio.js');
        await serveWerkMcp('factory', options);
    }
    else if (command === 'serve') {
        validateOptions(options, ['host', 'port', 'db', 'poll-timeout-ms', 'poll-concurrency']);
        const { startFactoryServer } = await import('./server.js');
        const app = await startFactoryServer({ managedRegistry: managedRegistryEnvironment(process.env.WERK_FACTORY_MANAGED_REGISTRY), db: options.db ?? '.state/factories.sqlite', host: options.host ?? '127.0.0.1', port: integer(options.port ?? '3100', 'port', 1, 65535), adminToken: process.env.WERK_FACTORY_ADMIN_TOKEN ?? '', pollTimeoutMs: integer(options['poll-timeout-ms'] ?? '3000', 'poll-timeout-ms', 50, 30000), pollConcurrency: integer(options['poll-concurrency'] ?? '4', 'poll-concurrency', 1, 16) });
        console.error(JSON.stringify({ event: 'factory_listening', address: app.server.address() }));
        process.on('SIGTERM', () => void app.close().catch(fail));
        process.on('SIGINT', () => void app.close().catch(fail));
    }
    else {
        const base = options.url ?? process.env.WERK_FACTORY_URL ?? 'http://127.0.0.1:3100', token = process.env.WERK_FACTORY_ADMIN_TOKEN ?? '';
        let result: unknown;
        if (command === 'health') {
            validateOptions(options, ['url']);
            result = await request(base, '/healthz', '');
        }
        else if (command === 'monitoring') {
            validateOptions(options, ['url']);
            result = await request(base, '/v1/monitoring', token);
        }
        else if (command === 'overview') {
            validateOptions(options, ['url', 'factory']);
            const query = options.factory ? '?factoryId=' + encodeURIComponent(identifier(options.factory, 'factory')) : '';
            result = await request(base, '/v1/overview' + query, token);
        }
        else {
            const [entity, action] = commands;
            if (commands.length !== 2 || !['factory', 'line'].includes(entity) || !['list', 'get', 'create', 'update', 'delete'].includes(action))
                throw new DomainError('invalid_input', 'Unknown command. Use --help.');
            const needsId = ['get', 'update', 'delete'].includes(action), needsFile = ['create', 'update'].includes(action);
            validateOptions(options, ['url', ...(needsId ? ['id'] : []), ...(needsFile ? ['file'] : []), ...(['create', 'update', 'delete'].includes(action) ? ['key'] : [])]);
            if (needsId && !options.id)
                throw new DomainError('invalid_input', '--id required');
            if (needsFile && !options.file)
                throw new DomainError('invalid_input', '--file required (use - for stdin)');
            const path = '/v1/' + (entity === 'factory' ? 'factories' : 'lines') + (needsId ? '/' + identifier(options.id, 'id') : '');
            const method = action === 'create' ? 'POST' : action === 'update' ? 'PATCH' : action === 'delete' ? 'DELETE' : 'GET';
            result = await request(base, path, token, method, needsFile ? await input(options.file) : undefined, mutationKey(options.key));
        }
        console.log(JSON.stringify(result));
    }
}
catch (error) {
    fail(error);
}
