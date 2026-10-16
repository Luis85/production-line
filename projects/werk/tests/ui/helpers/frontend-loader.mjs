import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Tests execute the same frontend state modules used by Vue, with controlled I/O.
// Browser code may share pure application policy; resolve its source dependencies too.
// Browser components and their mounted behavior are additionally exercised by browser journeys.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        specifier.startsWith(".") &&
        /(?:\/webview\/|\/src\/worker\/application\/)/.test(context.parentURL ?? "")
      ) {
        for (const candidate of [
          specifier.replace(/\.js$/, ".ts"),
          specifier + ".ts",
        ]) {
          const url = new URL(candidate, context.parentURL);
          if (existsSync(fileURLToPath(url)))
            return { url: url.href, shortCircuit: true };
        }
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (new URL(url).pathname.endsWith(".ts") && url.includes("/webview/"))
      return {
        format: "module",
        source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")),
        shortCircuit: true,
      };
    return nextLoad(url, context);
  },
});
export const frontend = (path) => import(pathToFileURL(resolve(path)).href);
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

let freshModule = 0;
export const freshFrontend = path => { const url = pathToFileURL(resolve(path)); url.searchParams.set('test', String(++freshModule)); return import(url.href); };
