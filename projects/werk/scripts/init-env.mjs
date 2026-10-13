import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const content=['WERK_ADMIN_TOKEN','WERK_ENROLLMENT_TOKEN'].map(k=>k+'='+randomBytes(32).toString('hex')).join('\n')+'\n';
await writeFile(new URL('../.env',import.meta.url),content,{mode:0o600,flag:'wx'});
console.log('Created .env with separate random tokens. Existing files are never overwritten.');
