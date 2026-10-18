import { createHash } from 'node:crypto';
import { readdir, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
                                                             
import { atomicWrite, assertDirectory, readBoundedFile, syncDirectory } from './files.js';

                   
                     
                   
                     
                           
                         
                        
  
const digest = (value         ) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const filename = 'acknowledged.json';
const allowedFiles = new Set(['before.json', 'after.json', filename]);

/** Only terminal-acknowledged evidence can be collected. Outbox delivery alone is insufficient. */
export class JournalRetention {
                     acknowledged = new Map                    ();
                     root        ;
                     keep        ;
    constructor(root        , keep        ) {
        this.root = root;
        this.keep = keep;
        if (!Number.isSafeInteger(keep) || keep < 0 || keep > 100000)
            throw Error('retainedPairs must be an integer in 0–100000');
    }
            directory(pairId        ) {
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(pairId)) throw Error('Invalid checkpoint pair');
        return join(this.root, pairId);
    }
            async read(pairId        )                             {
        const directory = this.directory(pairId);
        await assertDirectory(this.root);
        try {
            await assertDirectory(directory);
            const value = JSON.parse(await readBoundedFile(join(directory, filename), 2048));
            const fields = ['schemaVersion', 'pairId', 'workerId', 'acknowledgedAt', 'beforeSha256', 'afterSha256'];
            if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)) ||
                value.schemaVersion !== 1 || value.pairId !== pairId || typeof value.workerId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.workerId) ||
                typeof value.acknowledgedAt !== 'string' || !Number.isFinite(Date.parse(value.acknowledgedAt)) ||
                new Date(value.acknowledgedAt).toISOString() !== value.acknowledgedAt ||
                !/^[a-f0-9]{64}$/.test(value.beforeSha256) || !/^[a-f0-9]{64}$/.test(value.afterSha256))
                throw Error('Invalid worker acknowledgment checkpoint');
            return value              ;
        } catch (error) {
            if ((error                         ).code === 'ENOENT') return null;
            throw error;
        }
    }
            async verify(checkpoint            )                   {
        let complete = true;
        for (const phase of ['before', 'after']         ) {
            try {
                const data = JSON.parse(await readBoundedFile(join(this.directory(checkpoint.pairId), phase + '.json'), 131072));
                if (digest(data) !== (phase === 'before' ? checkpoint.beforeSha256 : checkpoint.afterSha256))
                    throw Error('Acknowledged snapshot digest mismatch');
            } catch (error) {
                if ((error                         ).code !== 'ENOENT') throw error;
                complete = false;
            }
        }
        return complete;
    }
    async restore(pairId        , workerId        )                   {
        const checkpoint = await this.read(pairId);
        if (!checkpoint) return false;
        if (checkpoint.workerId !== workerId) throw Error('Snapshot checkpoint belongs to another worker');
        if (!await this.verify(checkpoint)) {
            // A crash during collection may leave a checkpoint with only part of its acknowledged pair.
            await this.remove(checkpoint);
        } else this.acknowledged.set(pairId, checkpoint);
        return true;
    }
    async record(before          , after          )                {
        if (before.pairId !== after.pairId || before.phase !== 'before' || after.phase !== 'after' ||
            ['workerId', 'project', 'taskId', 'attempt', 'profileId', 'provider'].some(key => before[key                  ] !== after[key                  ]))
            throw Error('Cannot checkpoint mismatched snapshot pair');
        const checkpoint = await this.read(before.pairId) ?? {
            schemaVersion: 1         , pairId: before.pairId, workerId: before.workerId,
            acknowledgedAt: new Date().toISOString(), beforeSha256: digest(before), afterSha256: digest(after)
        };
        if (checkpoint.workerId !== before.workerId || checkpoint.beforeSha256 !== digest(before) || checkpoint.afterSha256 !== digest(after))
            throw Error('Acknowledged snapshot digest mismatch');
        await atomicWrite(join(this.directory(before.pairId), filename), JSON.stringify(checkpoint) + '\n');
        this.acknowledged.set(checkpoint.pairId, checkpoint);
        await this.prune();
    }
    async prune()                {
        const oldest = [...this.acknowledged.values()].sort((a, b) => a.acknowledgedAt.localeCompare(b.acknowledgedAt) || a.pairId.localeCompare(b.pairId));
        for (const checkpoint of oldest.slice(0, Math.max(0, oldest.length - this.keep))) {
            await this.remove(checkpoint);
            this.acknowledged.delete(checkpoint.pairId);
        }
    }
            async remove(checkpoint            )                {
        const directory = this.directory(checkpoint.pairId);
        await assertDirectory(this.root);
        await assertDirectory(directory);
        const files = await readdir(directory);
        if (files.some(file => !allowedFiles.has(file))) throw Error('Unexpected file in acknowledged snapshot directory; refusing cleanup');
        await this.verify(checkpoint);
        // The durable receipt survives until both evidence files are durably removed. Recovery never fabricates an after record.
        for (const phase of ['before', 'after'])
            await unlink(join(directory, phase + '.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await syncDirectory(directory);
        await unlink(join(directory, filename));
        await syncDirectory(directory);
        await rmdir(directory);
        await syncDirectory(this.root);
    }
}
