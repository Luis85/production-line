import { project, demoCommits } from './simulation-model.mjs';

/** Context behavior for one isolated, local simulation. */
export function createContext(state, api) {
  function repoNotes(id) {
    const feature =
      id === "atlas"
        ? "Bestellfreigabe"
        : id === "portal"
          ? "Rechnungsdownload"
          : "Einsatzplanung";
    return [
      {
        path: "requirements/" + feature + ".md",
        aliases: ["Featureanforderungen"],
        text:
          "# " +
          feature +
          "\n\n## Ziel\n" +
          (id === "atlas"
            ? "Bestellungen nachvollziehbar freigeben."
            : id === "portal"
              ? "Eigene Rechnungen sicher als PDF herunterladen."
              : "Techniker nach Qualifikation und Verfügbarkeit planen.") +
          "\n\n## Regeln\n" +
          (id === "atlas"
            ? "Ab 5.000 EUR sind zwei unterschiedliche Freigaben notwendig."
            : id === "portal"
              ? "Zugriff nur auf Rechnungen des eigenen Kundenkontos."
              : "Nur qualifizierte und verfügbare Techniker dürfen zugewiesen werden.") +
          " ^regel-1\n\n## Akzeptanz\nErfolgsfall, Grenzfälle und fehlende Berechtigung sind getestet.",
      },
      {
        path: "architecture/System.md",
        aliases: ["Systemarchitektur"],
        text:
          "# System\n\n## Grenzen\nUI, Anwendung und Domäne sind getrennt. Der Zugriff auf Infrastruktur erfolgt über Ports.\n\n## Stack\n" +
          project(id).stack,
      },
      {
        path: "quality/Definition of Done.md",
        aliases: ["DoD"],
        text: "# Definition of Done\n\n## Checks\nBuild, Typprüfung und Projekttests sind erfolgreich. Akzeptanzkriterien sind mit Nachweisen belegt.\n\n## Review\nPR enthält Testnachweise und fordert Review beim Projektteam an.",
      },
      {
        path: "domain/Glossar.md",
        aliases: [],
        text: "# Glossar\n\n## Begriffe\nFachbegriffe werden im Projekt einheitlich verwendet.",
      },
      {
        path: "legacy/Glossar.md",
        aliases: [],
        text: "# Glossar\n\n## Begriffe\nHistorische Begriffe; nicht ohne Rücksprache auf neue Features übertragen.",
      },
    ];
  }

  function parseWiki(raw) {
    const source = raw.trim();
    const m = source.match(/^\[\[([^\[\]\r\n]+)\]\]$/);
    if (!m)
      return {
        raw,
        error: "Wikilink erwartet: [[Pfad/Notiz#Abschnitt|Anzeige]]",
      };
    const parts = m[1].split("|");
    if (parts.length > 2)
      return { raw, error: "Nur ein Anzeigealias mit | ist zulässig." };
    const target = parts[0].trim(),
      hash = target.indexOf("#"),
      path = (hash < 0 ? target : target.slice(0, hash)).trim(),
      anchor = hash < 0 ? null : target.slice(hash + 1).trim();
    if (!path)
      return {
        raw,
        error:
          "Im Intake ist ein Notizpfad erforderlich; [[#Abschnitt]] hat keine Ausgangsnotiz.",
      };
    if (
      /[:\\%\u0000]/.test(path) ||
      path.startsWith("/") ||
      path.split("/").some((x) => !x || x === ".." || x === ".")
    )
      return {
        raw,
        error: "Nur Pfade innerhalb des Projekt-Vaults sind zulässig.",
      };
    if (anchor !== null && (!anchor || anchor.includes("#")))
      return {
        raw,
        error:
          "Im Demo-Resolver wird genau eine Überschrift oder #^Block-ID unterstützt.",
      };
    return {
      raw: source,
      path: path.endsWith(".md") ? path : path + ".md",
      anchor,
      label: parts[1]?.trim() || target,
    };
  }

  function resolveWiki(raw, id) {
    const parsed = parseWiki(raw);
    if (parsed.error) return parsed;
    const notes = repoNotes(id),
      full = parsed.path,
      short = full.replace(/\.md$/, "");
    let candidates = notes.filter((n) => n.path === full);
    if (!candidates.length && !short.includes("/"))
      candidates = notes.filter(
        (n) => n.path.split("/").at(-1) === full || n.aliases.includes(short),
      );
    if (!candidates.length)
      return { ...parsed, error: "Notiz im Demo-Index nicht gefunden." };
    if (candidates.length > 1)
      return {
        ...parsed,
        error: "Mehrdeutig. Bitte den vollständigen Vault-Pfad verwenden.",
        candidates: candidates.map((n) => n.path),
      };
    const note = candidates[0];
    let excerpt = note.text,
      selector = parsed.anchor ? "heading" : "file";
    if (parsed.anchor?.startsWith("^")) {
      selector = "block";
      const block = parsed.anchor.slice(1);
      if (!/^[a-zA-Z0-9-]+$/.test(block))
        return { ...parsed, error: "Ungültige Block-ID." };
      const found = note.text
        .split(/\n\s*\n/)
        .filter((p) =>
          p
            .split("\n")
            .some(
              (line) => line.endsWith(" ^" + block) || line === "^" + block,
            ),
        );
      if (found.length !== 1)
        return { ...parsed, error: "Block-ID nicht eindeutig vorhanden." };
      excerpt = found[0];
    } else if (parsed.anchor) {
      const lines = note.text.split("\n"),
        matches = [];
      lines.forEach((line, i) => {
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading && heading[2] === parsed.anchor)
          matches.push({ i, level: heading[1].length });
      });
      if (matches.length !== 1)
        return { ...parsed, error: "Überschrift nicht eindeutig vorhanden." };
      const start = matches[0];
      let end = lines.length;
      for (let i = start.i + 1; i < lines.length; i++) {
        const h = lines[i].match(/^(#{1,6})\s+/);
        if (h && h[1].length <= start.level) {
          end = i;
          break;
        }
      }
      excerpt = lines.slice(start.i, end).join("\n").trim();
    }
    return {
      ...parsed,
      vaultPath: note.path,
      repoPath: "docs/" + note.path,
      selector,
      excerpt,
      commit: demoCommits[id],
    };
  }

  function resolveContext(text, id) {
    if (!project(id))
      return { ok: false, entries: [], errors: ["Unbekanntes Projekt"] };
    if (!text.trim()) return { ok: true, entries: [], errors: [] };
    const entries = [],
      errors = [],
      seen = new Set();
    for (const line of text
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean)) {
      if (entries.length >= 12) {
        errors.push("Maximal zwölf Kontextlinks je Auftrag.");
        break;
      }
      const r = resolveWiki(line, id);
      if (r.error) {
        entries.push(r);
        errors.push(r.error);
      } else {
        const key = r.repoPath + "#" + (r.anchor || "");
        if (!seen.has(key)) {
          seen.add(key);
          entries.push(r);
        }
      }
    }
    return { ok: errors.length === 0, entries, errors };
  }

  function contextManifest(draft) {
    const r = resolveContext(draft.links, draft.project);
    if (!r.ok)
      throw Error("Bitte fehlende oder mehrdeutige Kontextlinks korrigieren.");
    return {
      schemaVersion: 1,
      resolverVersion: "demo-v1",
      projectId: draft.project,
      repository: project(draft.project).repo,
      vaultRoot: "docs",
      baseRef: "iteration/2026-W42",
      baseCommit: demoCommits[draft.project],
      source: "Demo-Index; kein Git-Zugriff",
      references: r.entries.map((e) => ({
        raw: e.raw,
        path: e.repoPath,
        anchor: e.anchor,
        selector: e.selector,
        excerpt: e.excerpt,
      })),
      traversal: { mode: "explicit-links", depth: 0, maxReferences: 12 },
    };
  }

  function validateContext(c, p) {
    if (
      c.schemaVersion !== 1 ||
      c.projectId !== p ||
      typeof c.baseCommit !== "string" ||
      !/^[a-f0-9]{40}$/.test(c.baseCommit) ||
      typeof c.vaultRoot !== "string" ||
      typeof c.source !== "string" ||
      !Array.isArray(c.references) ||
      c.references.length > 12
    )
      throw Error("Ungültiges Kontextmanifest");
    for (const r of c.references) {
      if (
        !r ||
        typeof r.raw !== "string" ||
        typeof r.path !== "string" ||
        !r.path.startsWith("docs/") ||
        r.path.split("/").includes("..") ||
        typeof r.excerpt !== "string" ||
        (r.anchor != null && typeof r.anchor !== "string")
      )
        throw Error("Ungültige Kontextreferenz");
    }
  }

  return {
    repoNotes,
    parseWiki,
    resolveWiki,
    resolveContext,
    contextManifest,
    validateContext,
  };
}
