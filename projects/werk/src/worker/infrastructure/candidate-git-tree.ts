import { createHash } from 'node:crypto';

type ObjectFormat = 'sha1' | 'sha256';
interface Tree { children: Map<string, Tree | { mode: string; hash: Buffer }>; }
const objectHash = (type: 'blob' | 'tree', body: Buffer, format: ObjectFormat) =>
  createHash(format).update(`${type} ${body.length}\0`).update(body).digest();
/** Computes the Git tree directly from the bytes checked by the worker, without clean filters or line-ending conversion. */
export function candidateGitTree(format: string) {
  if (format !== 'sha1' && format !== 'sha256') throw Error('Unsupported Git object format.');
  const algorithm: ObjectFormat = format, root: Tree = { children: new Map() };
  function add(path: string, body: Buffer, executable: boolean): void {
    const parts = path.split('/'); let directory = root;
    for (const part of parts.slice(0, -1)) {
      const previous = directory.children.get(part);
      if (previous && !('children' in previous)) throw Error('Candidate source contains conflicting file and directory paths.');
      const next: Tree = previous ?? { children: new Map() }; directory.children.set(part, next); directory = next;
    }
    const name = parts.at(-1)!;
    if (!name || directory.children.has(name)) throw Error('Candidate source contains duplicate paths.');
    directory.children.set(name, { mode: executable ? '100755' : '100644', hash: objectHash('blob', body, algorithm) });
  }
  function treeHash(tree: Tree): Buffer {
    const entries = [...tree.children].map(([name, item]) => ({ name, item, order: Buffer.from(name + ('children' in item ? '/' : '')) }));
    entries.sort((left, right) => Buffer.compare(left.order, right.order));
    const content = Buffer.concat(entries.flatMap(({ name, item }) => {
      const mode = 'children' in item ? '40000' : item.mode;
      return [Buffer.from(`${mode} ${name}\0`), 'children' in item ? treeHash(item) : item.hash];
    }));
    return objectHash('tree', content, algorithm);
  }
  return { add, digest: () => treeHash(root).toString('hex') };
}
