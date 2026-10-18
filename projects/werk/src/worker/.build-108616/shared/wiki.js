import { ValidationError } from './errors.js';

                                       
                                                                                       
                     
                 
                          
                         
                         
 

/** Parse one vault-relative Obsidian link without filesystem access or URI decoding. */
export function parseRequirementRef(value         )                       {
    if (typeof value !== 'string' || value.length > 500 || /[\p{Cc}\u2028\u2029]/u.test(value)) {
        throw new ValidationError('requirementRef: one Wikilink, at most 500 characters');
    }
    const match = /^\[\[([^\[\]]+)\]\]$/.exec(value.trim());
    if (!match) throw new ValidationError('requirementRef: use one [[vault/path/to/note]] Wikilink');
    const parts = match[1].split('|');
    if (parts.length > 2) throw new ValidationError('requirementRef: only one display alias is supported');
    const alias = parts.length === 2 ? parts[1].trim() : null;
    if (alias === '') throw new ValidationError('requirementRef: display alias must not be empty');
    const target = parts[0].trim();
    const anchorIndex = target.indexOf('#');
    const rawPath = (anchorIndex < 0 ? target : target.slice(0, anchorIndex)).trim();
    const anchor = anchorIndex < 0 ? null : target.slice(anchorIndex + 1).trim();
    if (anchor !== null && (!anchor || anchor.split('#').some(part => !part.trim()) || (anchor.startsWith('^') && !/^\^[A-Za-z0-9-]+$/.test(anchor)))) {
        throw new ValidationError('requirementRef: provide a heading or a valid #^block-id');
    }
    const path = rawPath.replace(/\.md$/i, '');
    if (!path || path.startsWith('/') || path.startsWith('~/') || /[:\\]/.test(path) || path.split('/').some(part => !part.trim() || ['.', '..'].includes(part.trim()))) {
        throw new ValidationError('requirementRef: use a relative project-vault path without traversal or a URI');
    }
    const wikilink = `[[${path}${anchor === null ? '' : '#' + anchor}${alias === null ? '' : '|' + alias}]]`;
    const displayTitle = (alias ?? path.split('/').at(-1) ).slice(0, 200);
    return { wikilink, path, anchor, alias, displayTitle };
}
