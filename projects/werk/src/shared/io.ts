/** Compatibility facade; application adapters should import their specific module. */
export { args, validateOptions, integer, input, fail } from './cli.js';
export { request } from './http/client.js';
export { readJson, json, html } from './http/server.js';
export { escapeHtml } from './html.js';
