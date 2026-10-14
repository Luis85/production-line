import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
// Every served Vue entry must resolve entirely within its release, without a CDN.
for (const app of ["factory", "orchestrator", "worker"])
  for (const file of app === "worker"
    ? ["index.html", "status.html"]
    : app === "factory"
      ? ["index.html", "guide.html"]
      : ["index.html", "guide.html", "concept.html"])
    test(`${app}/${file} ships a complete local executable Vue asset graph`, async () => {
      const root = resolve(`src/${app}/dist/${app}/public`),
        html = await readFile(resolve(root, file), "utf8");
      assert.match(html, /<div id="app"/);
      assert.match(html, /<script\b[^>]*type="module"/);
      assert.doesNotMatch(
        html,
        /<(?:script|link)\b[^>]*(?:src|href)="https?:\/\//,
      );
      const pending = [];
      for (const match of html.matchAll(
        /<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g,
      )) {
        if (match[1].startsWith("data:")) continue;
        assert(!match[1].includes(".."));
        pending.push(resolve(root, match[1].replace(/^\//, "")));
      }
      const seen = new Set();
      while (pending.length) {
        const path = pending.pop();
        if (seen.has(path)) continue;
        seen.add(path);
        const within = relative(root, path);
        assert(within && !isAbsolute(within) && within !== ".." && !within.startsWith("../") && !within.startsWith("..\\"), "asset stays inside package");
        assert((await stat(path)).isFile());
        const text = await readFile(path, "utf8");
        if (path.endsWith(".js"))
          for (const match of text.matchAll(
            /(?:from\s*|import\s*\()?["'](\.\.?\/[^"']+\.(?:js|css))["']/g,
          ))
            pending.push(resolve(dirname(path), match[1]));
      }
      const inline = [
        ...html.matchAll(
          /<script\b[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g,
        ),
      ].map((m) => m[1]);
      assert(
        seen.size > 0 || inline.some((script) => script.length > 1000),
        "interactive entry contains bundled executable dependencies",
      );
    });
