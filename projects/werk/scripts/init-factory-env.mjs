import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const keys=['WERK_FACTORY_ADMIN_TOKEN','WERK_ADMIN_TOKEN','WERK_ENROLLMENT_TOKEN','WERK_LINE_BETA_TOKEN','WERK_BETA_ENROLLMENT_TOKEN'];
await writeFile(new URL('../.env.factory',import.meta.url),keys.map(k=>k+'='+randomBytes(32).toString('hex')).join('\n')+'\n',{flag:'wx',mode:0o600});
console.log('Created .env.factory with distinct secrets. Existing files are never overwritten.');
