<template>
    <section class="technical-intro">
      <h2>Das Projekt-Repo ist die gemeinsame Arbeitsgrundlage.</h2>
      <p>
        Produktteam und Fabrik arbeiten zeitlich überlappend: Das Team
        spezifiziert die nächste Iteration, während die Fabrik die freigegebenen
        Features der aktuellen Iteration umsetzt.
      </p>
    </section>
    <section class="panel technical-section">
      <h2>Branches und Pull Requests</h2>
      <div class="table-wrap">
        <table>
          <tr>
            <th>Objekt</th>
            <th>Quelle → Ziel</th>
            <th>Verantwortung</th>
          </tr>
          <tr>
            <td>Iterations-Draft-PR</td>
            <td>iteration/2026-W42 → main</td>
            <td>Produktteam: Planung, Specs, Designs, Tests und Integration</td>
          </tr>
          <tr>
            <td>Feature-Draft-PR</td>
            <td>factory/REQ-241 → iteration/2026-W42</td>
            <td>Worker: beim Start öffnen; Code und Snapshot-Paare liefern</td>
          </tr>
          <tr>
            <td>Review-Nacharbeit</td>
            <td>Derselbe Feature-Branch und PR</td>
            <td>
              Neuer Versuch mit neuen Snapshots; bevorzugt derselbe Worker,
              Projektbindung bleibt verbindlich
            </td>
          </tr>
          <tr>
            <td>Feature-Merge</td>
            <td>Feature-PR ist in den Iterationsbranch gemerged</td>
            <td>
              Orchestrator markiert Task erledigt; Iterationsabschluss separat
            </td>
          </tr>
        </table>
      </div>
      <p>
        Ein erster Commit mit Vorher-Snapshot stellt bereits beim Arbeitsstart
        einen PR-Diff bereit. Der serverseitige Git-Publisher führt den Push im
        Auftrag des Workers aus und prüft die Lease. Nach Umsetzung und Checks
        kommen Code plus Nachher-Snapshot in denselben PR; anschließend wird
        menschliches Review angefordert.
      </p>
      <p>
        Freigaben und Checks gehören zum aktuellen PR-Head. Neue Änderungen
        machen alte Freigaben für den Abschluss ungültig. Kein automatischer
        Merge durch den Agenten. Abhängige Features werden erst nach Merge ihrer
        Voraussetzungen gestartet; Konflikte im Iterationsbranch führen in eine
        eigene Nacharbeitsschleife.
      </p>
    </section>
    <section class="panel technical-section">
      <h2>Obsidian, Intake und versionierte Snapshots</h2>
      <p>
        Der vollständige committed Vault bleibt verfügbar: Markdown, Properties,
        Links, Backlinks, Überschriften, Block-IDs, Einbettungen, Tags, Canvas
        und Anhänge. Der Importer interpretiert ausschließlich die vereinbarten
        Factory-Properties. Die übrigen Obsidian-Inhalte sind Kontext und werden
        über dafür geeignete Reader erschlossen; der Starter rendert nicht
        sämtliche Obsidian-Core-Funktionen.
      </p>
      <p>
        Idempotenzschlüssel: Projekt + Iteration + Feature-ID. Ready-Features
        werden am Git-Commit gepinnt. Änderungen an bereits importierten Specs
        erfordern eine explizite Revision; ein erneuter Scan erzeugt keine
        Duplikate. Die nächste Iteration nutzt einen getrennten Planungsbranch;
        Übernahme von Änderungen und Rebase werden bewusst gesteuert.
      </p>
      <pre class="code">
.factory/runs/FEATURE-ID/attempt-N/LEASE-ID/before.json
.factory/runs/FEATURE-ID/attempt-N/LEASE-ID/after.json</pre
      >
      <p>
        Snapshots sind unveränderlich, schema-versioniert und mit SHA-256 im
        Orchestrator indexiert. Ein Outbox-Journal überträgt sie erneut bei
        Netzverlust. Späte Telemetrie wird ihrem alten Versuch zugeordnet; sie
        darf keinen Task abschließen. Bei einem harten Absturz entsteht nach
        Wiederanlauf ein als rekonstruiert markierter Abbruch-Snapshot. Fehlt
        dieser dauerhaft, bleibt die Datenlücke sichtbar.
      </p>
      <p>
        Der Nachher-Snapshot enthält den geprüften Code-Stand. Der finale
        Telemetrie-Commit kann nicht seinen eigenen Hash enthalten. PR, finaler
        Head, spätere CI und Review-Ergebnisse werden deshalb als separate
        Ereignisse ergänzt. Langfristige Zeitreihen liegen in SQLite, die
        prüfbaren Originaldateien im Feature-PR.
      </p>
    </section>
    <section class="panel technical-section">
      <h2>Docker Agent als optionale Laufzeit</h2>
      <p>
        Docker Agent kann einen Worker-Versuch ausführen oder Factory-Funktionen
        über MCP bedienen. Es ist kein zusätzlicher Modellanbieter:
        Subscription-Profile bleiben Claude und Codex.
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Integration</th>
              <th scope="col">Verantwortung und Grenze</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Factory-Steuerung über MCP</td>
              <td>
                Die bereitgestellten Verwaltungstools und eine separate
                Docker-Agent-Konfiguration verbinden den Agenten mit den
                freigegebenen Factory-/Orchestrator-Schnittstellen.
                Servervalidierung und Liniengrenzen bleiben verbindlich.
              </td>
            </tr>
            <tr>
              <td>Claude-Code- oder Codex-Harness</td>
              <td>
                Separate Harness-Konfigurationen nutzen die jeweilige native
                CLI-Anmeldung. Docker-Agent-Toolsets werden in diesem
                Harness-Modus nicht übernommen; die erlaubten Tools und Skills
                müssen über den jeweiligen Coding-Runner kontrolliert werden.
              </td>
            </tr>
            <tr>
              <td>Agententeam im Worker-Versuch</td>
              <td>
                Ein Team arbeitet innerhalb eines reservierten Versuchs und
                seines Arbeitsverzeichnisses. Taskboard, Leases,
                Snapshot-Nachweise und der menschliche Review-/Merge-Abschluss
                bleiben unter Kontrolle des Orchestrators.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="notice">
        Integrationsstand: Verwaltung über MCP und Beispielkonfigurationen sind
        ein eigener Einstieg. Die automatische Coding-Ausführung eines
        Worker-Versuchs über Docker Agent ist noch nicht live verbunden. Diese
        Browserdemo startet weder Docker Agent noch Provider-CLIs.
      </p>
      <a
        href="https://docker.github.io/docker-agent/features/harnesses/"
        target="_blank"
        rel="noopener noreferrer"
        >Docker Agent: Coding-Harnesses und native CLI-Anmeldung</a
      >
    </section>
</template>
