import { DomainError } from '../../shared/errors.js';
import { gitContextSource } from './git-source.js';
import { resolveContext } from './resolver.js';

/** Operator-controlled local preview; does not create tasks or enable live execution. */
export async function resolveContextCommand(options: Record<string, string>) {
    for (const key of ['repo', 'commit', 'vault-root', 'wikilink', 'project']) {
        if (!options[key]) throw new DomainError('invalid_input', `--${key} required`);
    }
    const source = await gitContextSource(options.repo, options.commit);
    return resolveContext(source, { project: options.project, vaultRoot: options['vault-root'], wikilink: options.wikilink });
}
