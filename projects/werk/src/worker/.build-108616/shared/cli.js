import { open } from 'node:fs/promises';
import { DomainError, ValidationError } from './errors.js';
import { ApiError } from './http/errors.js';
const INPUT_LIMIT = 65536;
export function args(argv = process.argv.slice(2))   
                       
                                    
  {
    const commands           = [], options                         = {};
    for (let i = 0; i < argv.length; i++) {
        const item = argv[i];
        if (!item.startsWith('--')) {
            commands.push(item);
            continue;
        }
        if (!/^--[a-z][a-z0-9-]*$/.test(item))
            throw new ValidationError(`Invalid option: ${item}`);
        if (Object.hasOwn(options, item.slice(2)))
            throw new ValidationError(`Duplicate option: ${item}`);
        if (item === '--help') {
            options.help = 'true';
            continue;
        }
        if (!argv[i + 1] || argv[i + 1].startsWith('--'))
            throw new ValidationError(`Value required: ${item}`);
        options[item.slice(2)] = argv[++i];
    }
    return { commands, options };
}
export function validateOptions(options                        , allowed          ) {
    const unknown = Object.keys(options).find(k => k !== 'help' && !allowed.includes(k));
    if (unknown)
        throw new ValidationError(`Unknown option --${unknown}`);
}
export function integer(value        , name        , min        , max        )         {
    const n = Number(value);
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max)
        throw new ValidationError(`${name}: integer ${min}–${max}`);
    return n;
}
async function readInput(path        , limit        )                  {
    const limitMessage = `Input limit: ${limit / 1024} KiB`;
    const chunks           = [];
    let size = 0;
    const append = (chunk        ) => { size += chunk.length; if (size > limit)
        throw new DomainError('too_large', limitMessage); chunks.push(chunk); };
    if (path === '-') {
        for await (const chunk of process.stdin)
            append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    else {
        let handle;
        try {
            handle = await open(path, 'r');
            const info = await handle.stat();
            if (!info.isFile())
                throw new ValidationError('Input path must be a regular file');
            if (info.size > limit)
                throw new DomainError('too_large', limitMessage);
            for (;;) {
                const buffer = Buffer.alloc(8192);
                const { bytesRead } = await handle.read(buffer);
                if (!bytesRead)
                    break;
                append(buffer.subarray(0, bytesRead));
            }
        }
        catch (error) {
            if (error instanceof DomainError)
                throw error;
            throw new ValidationError(`Cannot read input file (${(error                         ).code ?? 'I/O error'})`);
        }
        finally {
            await handle?.close();
        }
    }
    return Buffer.concat(chunks);
}
/** Read a file or stdin (-) under one size limit. JSON by default; { text: true } returns the UTF-8 text unparsed. Both drop a leading BOM. */
export async function input(path        , limit = INPUT_LIMIT, options                     = {})                   {
    // Windows PowerShell 5.1 prefixes piped stdin, and many editors prefix saved files, with a UTF-8 BOM.
    const text = (await readInput(path, limit)).toString('utf8').replace(/^\uFEFF/, '');
    if (options.text)
        return text;
    try {
        return JSON.parse(text);
    }
    catch {
        throw new ValidationError('Invalid JSON input');
    }
}
export function fail(error         ) {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unexpected error';
    console.error(JSON.stringify({ error: message }));
    process.exitCode = (error instanceof DomainError && !['internal', 'unavailable'].includes(error.code)) || (error instanceof ApiError && error.status < 500) ? 2 : 1;
}
