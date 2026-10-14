import { fileURLToPath } from 'node:url';
import { webviewConfig } from '../../../scripts/webviews.mjs';
export default webviewConfig(fileURLToPath(new URL('.', import.meta.url)));
