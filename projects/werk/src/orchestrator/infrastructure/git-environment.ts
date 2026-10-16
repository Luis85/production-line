import { gitEnvironment } from '../../shared/git/environment.js';
/** Environment for immutable, local-only Git reads; inherited Git overrides are never authority. */
export function immutableGitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return gitEnvironment('immutable', source);
}
