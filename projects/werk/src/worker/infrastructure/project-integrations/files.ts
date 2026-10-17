import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DomainError } from "../../../shared/errors.js";
import type { Observation } from './metadata.js';
import { hash } from './metadata.js';

export async function exists(path: string) {
  return lstat(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
}

export async function rootDirectory(value: string) {
  if (typeof value !== "string" || !value.trim())
    throw new DomainError(
      "invalid_input",
      "Choose an existing project directory.",
    );
  const root = await realpath(resolve(value));
  if (!(await lstat(root)).isDirectory())
    throw new DomainError(
      "invalid_input",
      "Choose an existing project directory.",
    );
  return root;
}

export async function observe(root: string, path: string): Promise<Observation> {
  let current = root;
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const info = await exists(current);
    if (!info) return { text: null, sha256: null, mode: null, blocked: null };
    if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory()))
      return {
        text: null,
        sha256: null,
        mode: null,
        blocked: "Path contains a symbolic link or non-directory ancestor.",
      };
    if (i < parts.length - 1) continue;
    if (!info.isFile() || info.nlink !== 1)
      return {
        text: null,
        sha256: null,
        mode: null,
        blocked: "Target must be a regular file with a single hard link.",
      };
    if (info.size > 65536)
      return {
        text: null,
        sha256: null,
        mode: null,
        blocked: "Target exceeds the 64 KiB integration limit.",
      };
    const file = await open(
      current,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const checked = await file.stat();
      if (!checked.isFile() || checked.nlink !== 1 || checked.size > 65536)
        throw new DomainError(
          "conflict",
          "Integration target changed while reading.",
        );
      const bytes = Buffer.alloc(65537);
      let size = 0;
      while (size < bytes.length) {
        const part = await file.read(bytes, size, bytes.length - size, null);
        if (!part.bytesRead) break;
        size += part.bytesRead;
      }
      if (size > 65536)
        return {
          text: null,
          sha256: null,
          mode: null,
          blocked: "Target exceeds the 64 KiB integration limit.",
        };
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, size),
      );
      return {
        text,
        sha256: hash(text),
        mode: checked.mode & 0o777,
        blocked: null,
      };
    } finally {
      await file.close();
    }
  }
  throw new DomainError("invalid_input", "Invalid integration path.");
}

export async function parents(root: string, path: string) {
  let current = root;
  for (const part of path.split("/").slice(0, -1)) {
    current = join(current, part);
    const info = await exists(current);
    if (!info) await mkdir(current, { mode: 0o700 });
    else if (!info.isDirectory() || info.isSymbolicLink())
      throw new DomainError(
        "conflict",
        "Integration directory changed; inspect the plan again.",
      );
  }
}

export async function publish(
  root: string,
  path: string,
  text: string,
  before: string | null,
  mode = 0o600,
) {
  await parents(root, path);
  const current = await observe(root, path);
  if (current.blocked || current.sha256 !== before)
    throw new DomainError(
      "conflict",
      "Integration file changed; inspect the plan again.",
    );
  const absolute = join(root, ...path.split("/"));
  if (before === null) {
    const file = await open(absolute, "wx", mode);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
  } else {
    const temporary = join(
      dirname(absolute),
      ".werk-integration-" + randomUUID() + ".tmp",
    );
    const file = await open(temporary, "wx", current.mode ?? mode);
    try {
      await file.writeFile(text);
      await file.sync();
      await file.close();
      const observed = await observe(root, path);
      if (observed.blocked || observed.sha256 !== before)
        throw new DomainError(
          "conflict",
          "Integration file changed; inspect the plan again.",
        );
      await parents(root, path);
      await rename(temporary, absolute);
    } finally {
      await file.close().catch(() => {});
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}
