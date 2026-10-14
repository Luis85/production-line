<template>
  <div class="concept-system-documentation">
    <p class="concept-note">
      Zielarchitektur und lokale Konzeptsimulation: Die folgenden Git-, Quota-
      und Check-Abläufe sind illustrative Entwurfsregeln. Der
      Live-Runtime-Vertrag steht im Systemguide und in den ausgelieferten
      Referenzen; diese Demo startet keine Provider und publiziert keine PRs.
    </p>
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
    <div class="technical-intro">
      <h2>Factory → Produktionslinie → Orchestrator und Worker.</h2>
      <p>
        Factories können weitere Factories enthalten. Jede Produktionslinie
        besitzt genau einen eigenen Orchestrator mit eigener Queue und eigenen
        Workern. src/factory verwaltet den Katalog; zwischen Linien werden keine
        Tasks automatisch verschoben. Die Browserdemo simuliert diese isolierten
        Linien in einem gemeinsamen lokalen Datenstand.
      </p>
      <p>
        Der Orchestrator stellt diese Weboberfläche, den Intake und die
        Worker-API bereit. Node-Clients holen reservierte Aufträge, führen den
        Agenten lokal aus und liefern einen geprüften Änderungssatz. Die
        verbindliche Prozesssteuerung bleibt im Server und im Worker-Dienst.
      </p>
      <span class="pill"
        >Zielarchitektur · separater Entwicklungsstarter mit
        Mock-Ausführung</span
      >
    </div>
    <div class="dashboard-grid">
      <section class="panel">
        <h2>Server / Control Plane</h2>
        <div class="table-wrap">
          <table>
            <tr>
              <th>Modul</th>
              <th>Verantwortung</th>
            </tr>
            <tr>
              <td>Web + Intake API</td>
              <td>
                Projektteam-Anmeldung, Feature, Kriterien, Wikilinks,
                Kontextvorschau
              </td>
            </tr>
            <tr>
              <td>Repo-Indexer</td>
              <td>
                Read-only Git-Mirror; Vault-Pfade, Überschriften, Block-IDs und
                Aliase je Commit
              </td>
            </tr>
            <tr>
              <td>Scheduler + Task Store</td>
              <td>
                Projektbindung, Priorität, Slots; atomare Vergabe, Lease und
                Versuchszähler
              </td>
            </tr>
            <tr>
              <td>Publication / Git Adapter</td>
              <td>
                Geprüfte Änderung publizieren, PR erstellen oder aktualisieren,
                Review anfordern
              </td>
            </tr>
            <tr>
              <td>PR Monitor</td>
              <td>
                Signierte Webhooks deduplizieren, Git-Zustand regelmäßig
                abgleichen
              </td>
            </tr>
            <tr>
              <td>Event API</td>
              <td>
                SSE für Webview; geordnete Worker-Ereignisse mit Sequenznummer
              </td>
            </tr>
          </table>
        </div>
        <p>
          <b>MVP-Vorschlag:</b> Node.js + TypeScript, SQLite im WAL-Modus und
          eine vom Server ausgelieferte Webview mit Intake als Startseite.
          Queue, Leases und Events liegen zunächst in derselben Datenbank. Ein
          Orchestrator-Prozess besitzt die Datei; Worker greifen ausschließlich
          über HTTP auf den Server zu. Redis ist zunächst nicht erforderlich.
        </p>
      </section>
      <section class="panel">
        <h2>Client / Worker-Dienst</h2>
        <div class="table-wrap">
          <table>
            <tr>
              <th>Modul</th>
              <th>Verantwortung</th>
            </tr>
            <tr>
              <td>Poller + Heartbeat</td>
              <td>
                Eigene Zuweisung abholen, Empfang bestätigen, Lease erneuern
              </td>
            </tr>
            <tr>
              <td>Workspace Manager</td>
              <td>
                Repo synchronisieren; Checkout und separaten Worktree am
                festgelegten Commit erzeugen
              </td>
            </tr>
            <tr>
              <td>Context Resolver</td>
              <td>
                Manifest verifizieren; referenzierte Passagen lesen, weitere
                Notizen gezielt erschließen
              </td>
            </tr>
            <tr>
              <td>Agent Runner Adapter</td>
              <td>
                Claude- oder Codex-CLI starten; JSONL normalisieren, Budget und
                Abbruch behandeln
              </td>
            </tr>
            <tr>
              <td>Factory Tools</td>
              <td>
                Schema-validierte lokale Tools für Lesen, Prüfungen, Diff und
                Rückfragen
              </td>
            </tr>
            <tr>
              <td>Reporter + Journal</td>
              <td>
                Nachweise, Anbieter-Session-ID, Ereignisse und
                Wiederanlaufzustand festhalten
              </td>
            </tr>
          </table>
        </div>
        <p>
          Der Client läuft als Dienst mit eigener Projektidentität und
          konfigurierbaren Maschinen- und Profil-Slots. Er öffnet ausgehende
          HTTPS-Verbindungen. Browser und Agent erhalten keine Worker-Identität.
        </p>
      </section>
    </div>
    <section class="panel technical-section">
      <h2>Protokoll: gezielt pollen statt das ganze Board lesen</h2>
      <p>
        Das Board ist eine Darstellung des Serverzustands. Der Worker verwendet
        eine schmale API; seine Projektbindung wird aus der authentifizierten
        Identität ermittelt.
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Vorgeschlagener Endpunkt</th>
              <th>Vertrag</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>POST /v1/context/resolve</code></td>
              <td>
                Projekt und Git-Commit prüfen; Wikilinks in eine versionierte
                Vorschau auflösen
              </td>
            </tr>
            <tr>
              <td><code>POST /v1/tasks</code></td>
              <td>
                Feature, Kriterien, Provider-Policy und Kontextmanifest erneut
                validieren; atomar einreihen
              </td>
            </tr>
            <tr>
              <td><code>GET /v1/events</code></td>
              <td>
                SSE für autorisierte Projekte; Fortsetzung ab letzter Event-ID
              </td>
            </tr>
            <tr>
              <td><code>POST /v1/workers/register</code></td>
              <td>
                Einmalige Registrierung mit serverseitig freigegebener
                Projektbindung und Fähigkeiten
              </td>
            </tr>
            <tr>
              <td><code>POST /v1/worker/assignments/next</code></td>
              <td>
                Atomar reservieren; Idempotency-Key; Long-Poll bis 25 s, sonst
                204. Bei Retry dieselbe aktive Zuweisung liefern.
              </td>
            </tr>
            <tr>
              <td><code>POST /v1/leases/:id/ack</code></td>
              <td>Attempt und Fencing-Token prüfen; Startfrist bestätigen</td>
            </tr>
            <tr>
              <td><code>POST /v1/leases/:id/heartbeat</code></td>
              <td>Beispiel: alle 10 s, TTL 60 s. Serverzeit ist maßgeblich.</td>
            </tr>
            <tr>
              <td><code>POST /v1/attempts/:id/events</code></td>
              <td>
                Sequenznummer + Event-ID; deduplizieren, im Worker puffern und
                erneut zustellen
              </td>
            </tr>
            <tr>
              <td><code>POST /v1/attempts/:id/publish</code></td>
              <td>
                Aktive Lease, Manifest, getesteten Commit und Nachweise prüfen;
                Publikationsauftrag atomar speichern
              </td>
            </tr>
            <tr>
              <td><code>POST /v1/git/webhooks</code></td>
              <td>
                Review, CI und Merge verifizieren; Hintergrundabgleich gleicht
                fehlende Ereignisse aus
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="flow-note">
        Bei Netzverlust stoppt der Worker vor Ablauf seiner lokalen
        konservativen Lease-Frist; ohne bestätigte Lease wird nicht publiziert.
        Ein verspätetes Ergebnis wird mit 409 abgewiesen. Erneute Zustellung ist
        erlaubt, doppelte fachliche Wirkung wird über Idempotenz und Abgleich
        verhindert.
      </div>
    </section>
    <div class="dashboard-grid">
      <section class="panel">
        <h2>Kontext als versionierter Vertrag</h2>
        <ol class="plain-steps">
          <li>
            Projektkonfiguration legt Repo, Zielbranch und Vault-Root fest.
          </li>
          <li>Server löst Wikilinks am ausgewählten Git-Commit auf.</li>
          <li>
            Fehlende oder mehrdeutige Pflichtreferenzen blockieren die Aufnahme.
          </li>
          <li>
            Kontextmanifest fixiert Pfad, Selektor, Commit, Blob-ID bzw. SHA-256
            und Resolver-Version.
          </li>
          <li>
            Worker prüft denselben Stand vor Ausführung und protokolliert
            zusätzlich gelesene Quellen.
          </li>
        </ol>
        <p>
          Vollständiger Repo-Kontext ist lokal verfügbar. Der Startprompt
          enthält Auftrag, Manifest und ausgewählte Passagen. Weitere Referenzen
          werden gezielt nachgeladen, mit Mengenlimit und Zyklenerkennung.
        </p>
        <p>
          Uncommitted Obsidian-Notizen werden nicht verteilt. Ein neuer
          Zielbranch-Stand oder neue fachliche Kriterien erzeugen eine explizite
          Revision; Kontext wird niemals still ausgetauscht.
        </p>
        <div class="flow-note">
          MVP-Resolver: Markdown-Notiz, eindeutiger Kurzname/Alias, Überschrift
          und Block-ID. Vollständige Vault-Pfade lösen Mehrdeutigkeiten auf. Bei
          Vaults unterhalb des Repos ist der Vault-Root explizit konfiguriert.
          Symlinks und Pfade außerhalb erlaubter Wurzeln werden im realen
          Resolver abgewiesen.
        </div>
      </section>
      <section class="panel">
        <h2>Assignment-Schema (Vorschlag)</h2>
        <pre class="code">
interface Assignment {
  schemaVersion: 1;
  taskId: string;
  taskRevision: number;
  attemptId: string;
  workerId: string;
  projectId: string;
  lease: {
    id: string;
    fencingToken: number;
    expiresAt: string;
  };
  repository: string;
  baseCommit: string;
  targetBranch: string;
  branch: string;
  acceptanceCriteria: string[];
  contextManifestId: string;
  contextManifestSha256: string;
  stackProfileVersion: string;
  policyVersion: string;
  skillBundleVersion: string;
  provider: string; // registrierter Adapter
  profileId: string;
  adapterVersion: string;
  subscriptionRef: string; // keine Secrets
  timeoutSeconds: number;
  providerOptions: Record&lt;string, unknown&gt;;
}</pre
        >
        <p>
          Revision beschreibt die fachliche Eingabe. Attempt beschreibt einen
          Ausführungsversuch. Ein neuer Versuch erhält eine neue Lease; eine
          Provider-Session ist weder Task noch Lease.
        </p>
      </section>
    </div>
    <section class="panel technical-section">
      <h2>Deterministischer Rahmen, agentische Implementierung</h2>
      <p>
        Der Node-Prozess führt die Zustandsmaschine aus: empfangen → bestätigen
        → Workspace vorbereiten → Kontext prüfen → Agent ausführen → unabhängige
        Checks → Publikation anfordern → Übergabe bestätigen. Das
        Agentenergebnis allein schließt keinen Auftrag ab.
      </p>
      <div class="table-wrap">
        <table>
          <tr>
            <th>Schicht</th>
            <th>Beispiele</th>
            <th>Verbindlichkeit</th>
          </tr>
          <tr>
            <td>Skills / Markdown</td>
            <td>
              Feature implementieren, Projektkonventionen, Review-Änderungen
              bearbeiten
            </td>
            <td>
              Arbeitsanweisungen; keine Garantie für Reihenfolge oder Ergebnis
            </td>
          </tr>
          <tr>
            <td>Lokale Factory-Tools</td>
            <td>
              <code>context.read</code>, <code>context.resolve</code>,
              <code>checks.run</code>, <code>diff.inspect</code>,
              <code>question.raise</code>
            </td>
            <td>
              Eingabeschema, Pfadgrenzen, erlaubte Check-IDs, strukturierte
              Ergebnisse
            </td>
          </tr>
          <tr>
            <td>Worker-Zustandsmaschine</td>
            <td>
              Lease prüfen, Check-Exitcodes auswerten, Budget begrenzen,
              Testnachweis an Commit binden
            </td>
            <td>Durch TypeScript-Code erzwungen</td>
          </tr>
          <tr>
            <td>Server / Git Gates</td>
            <td>
              Projektberechtigung, aktuelle Attempt-Version, CI-Status, Review,
              Branch-Schutz, Merge
            </td>
            <td>Autoritative Freigabe; Agent kann keine Gates überspringen</td>
          </tr>
        </table>
      </div>
      <p>
        Jede Änderung nach einem Testlauf macht dessen Nachweis ungültig. Der
        Worker führt verpflichtende Checks selbst aus; ein Toolaufruf des
        Agenten ersetzt diese Freigabe nicht. Reproduzierbar sind Konfiguration,
        Eingaben und Gates; das erzeugte Modellresultat ist nicht
        deterministisch.
      </p>
    </section>
    <div class="dashboard-grid">
      <section class="panel">
        <h2>Provider-neutrale Runner-Adapter</h2>
        <p>
          Start mit <b>Claude Code CLI</b> und <b>Codex CLI</b>, jeweils über
          die lokal eingerichtete Subscription-Anmeldung. Cursor ist eine
          spätere Erweiterung hinter demselben Vertrag. Ein Worker kann mehrere
          Profile desselben oder verschiedener Anbieter besitzen.
        </p>
        <div class="table-wrap">
          <table>
            <tr>
              <th>Adapter</th>
              <th>Programmatischer Einstieg</th>
            </tr>
            <tr>
              <td>Claude</td>
              <td>
                <code>claude -p --output-format stream-json --verbose</code>
              </td>
            </tr>
            <tr>
              <td>Codex</td>
              <td>
                <code>codex exec --json --sandbox workspace-write -</code>
              </td>
            </tr>
            <tr>
              <td>Cursor</td>
              <td>Vorgesehener Adapter; noch kein implementierter Vertrag</td>
            </tr>
          </table>
        </div>
        <p>
          Der Node-Dienst startet Kindprozesse mit Argumentarrays und
          <code>shell: false</code>, übergibt das Auftragspaket über stdin und
          normalisiert JSONL-Ereignisse. Exitcode, finales Ergebnis und
          vollständiges Stream-Ende werden gemeinsam geprüft. Fehlende
          Funktionen werden als nicht unterstützt gemeldet, nicht still ersetzt.
        </p>
        <p>
          SDKs bleiben eine austauschbare Transportoption innerhalb des
          Adapters. Der gemeinsame Prozess kennt keine Claude-spezifischen
          Klassen, Session-IDs oder Settings.
        </p>
        <pre class="code">
interface AgentAdapter {
  probe(profile: Profile): Promise&lt;Health&gt;;
  capabilities(): Capabilities;
  run(input: RunInput,
      signal: AbortSignal): AsyncIterable&lt;AgentEvent&gt;;
}
// Gemeinsame Events:
// started, progress, toolCall, artifact,
// needsInput, usage, completed, failed
// Resume ist eine optionale Fähigkeit.</pre
        >
        <div class="flow-note">
          Tool- und Skill-Bundles werden im Factory-Format versioniert und
          adapterspezifisch eingebunden. Gemeinsame Tools können über lokales
          MCP bereitstehen; lokale Factory-CLI-Befehle bieten eine testbare
          zweite Schnittstelle. Fähigkeiten und Aufrufdetails werden je
          unterstützter CLI-Version geprüft.
        </div>
      </section>
      <section class="panel">
        <h2>PR-Erstellung im Auftrag des Workers</h2>
        <p>
          Der Worker initiiert die Publikation mit Änderungssatz, Testnachweisen
          und PR-Text. Der Server-Publisher besitzt die Git-Schreibrechte und
          erstellt oder aktualisiert den PR im Namen dieses Versuchs.
          Anschließend fordert er das Projektteam zum Review auf.
        </p>
        <p>
          Diese Trennung macht das Fencing wirksam: Ein alter Worker kann nach
          Lease-Verlust nicht mit einem langlebigen Git-Token weiter
          publizieren. Direkte Git-Schreibrechte auf jedem Worker würden diese
          Garantie aufweichen.
        </p>
        <p>
          Publikationsoperationen werden je Task-Revision serialisiert. Ein
          stabiler Branch und eine PR-Korrelations-ID ermöglichen Wiederaufnahme
          nach einem Absturz zwischen Push und PR-Erstellung; vor Wiederholung
          wird Git abgeglichen.
        </p>
        <div class="flow-note">
          Transport: mindestens einmal. Fachliche Verarbeitung: idempotent. Kein
          behauptetes „Exactly once“ über Datenbank und externen Git-Provider.
        </div>
      </section>
    </div>
    <section class="panel technical-section">
      <h2>Subscription-Profile und Kapazität</h2>
      <p>
        Ein Profil verbindet Provider, lokale Authentifizierungsreferenz,
        unterstützte Modelle, Adapter-Version und Status. Secrets verbleiben auf
        der Maschine bzw. im Credential Store. Der Server erhält nur eine opake
        Profil-/Subscription-Referenz und die Verfügbarkeit.
      </p>
      <p>
        <b>Maschine ≠ Profil ≠ Kontingent:</b> Maschinen-Slots begrenzen CPU/RAM
        und Worktrees; Profil-Slots begrenzen parallele CLI-Sessions; eine
        Subscription kann ein gemeinsames Limit über mehrere Profile haben.
        Derselbe Account wird deshalb serverseitig einer gemeinsamen
        Quota-Gruppe zugeordnet, ohne Anmeldedaten zu kopieren.
      </p>
      <p>
        Die lokale CLI-Anmeldung ist der Ausgangspunkt. Der Healthcheck prüft
        Login, Binärversion, Konfiguration und eine explizit ausgelöste Probe.
        Ein Login allein garantiert kein Restkontingent. Fehlende
        Limit-Telemetrie bleibt „unbekannt“. Unbeabsichtigte API-Key-Overrides
        werden erkannt; es gibt keinen stillen Wechsel von Subscription zu
        API-Abrechnung.
      </p>
      <p>
        Reale Provider-Ausführung verwendet die geprüften Worker-Adapter mit
        ihren wirksamen Einschränkungen. Projekt-Skills werden von diesen
        eingeschränkten Subprozessen bewusst nicht übernommen. Native
        CLI-Logins, private API-Schlüssel und Subscription-Abrechnung sind
        unterschiedliche Zugangswege; ein Login beweist kein Restkontingent.
      </p>
      <p>
        Bei Loginverlust oder Limit pausiert das betroffene Profil. Ein aktiver
        Versuch wird angehalten. Neue Anbieterzuordnung erfolgt erst als neuer,
        protokollierter Versuch nach Freigabe; native Sessions werden nicht
        zwischen Anbietern übertragen.
      </p>
      <p>
        <b>Empfohlener erster Ausbauschritt:</b> ein Server, SQLite, ein
        Git-Provider, ein Worker je Projekt mit Claude- und Codex-Profilen und
        konfigurierbaren Slots. Heartbeat, Kontextmanifest, Agentlauf,
        Checknachweise und PR-Monitor bilden einen vertikalen Durchstich.
        Verteiltes Scheduling und zusätzliche Queue-Infrastruktur folgen erst
        bei Bedarf.
      </p>
      <p>
        <b>Diese Browserdemo:</b> Intake, Kontextresolver, Provider-Profile,
        Checks und Git-Ereignisse laufen lokal mit Beispielnotizen. Der separate
        Werk-Runtime unterstützt koordinierte Mock-Ausführung sowie ausdrücklich
        konfigurierte reale Codex-Ausführung und lokale
        Worker-Chat-/Dateiaufgaben über Claude, Codex oder API-Verbindungen.
        Freigegebene Dateisnapshots und Hashprüfungen schützen die lokale
        Patch-Review. Automatische PR-Publikation, verifizierte CI-Qualität und
        Merge-Verfolgung sind getrennte Fähigkeiten und werden von dieser Demo
        nicht zugesichert.
      </p>
      <details class="detail-disclosure">
        <summary>Offizielle Quellen · geprüft am 12.10.2026</summary>
        <ul>
          <li>
            <a
              href="https://learn.chatgpt.com/docs/non-interactive-mode"
              target="_blank"
              rel="noopener noreferrer"
              >Codex CLI: programmatischer Betrieb und Anmeldung</a
            >
          </li>
          <li>
            <a
              href="https://learn.chatgpt.com/docs/auth"
              target="_blank"
              rel="noopener noreferrer"
              >Codex: Authentifizierung</a
            >
          </li>
          <li>
            <a
              href="https://code.claude.com/docs/en/headless"
              target="_blank"
              rel="noopener noreferrer"
              >Claude Code CLI: programmatischer Betrieb</a
            >
          </li>
          <li>
            <a
              href="https://code.claude.com/docs/en/authentication"
              target="_blank"
              rel="noopener noreferrer"
              >Claude Code: lokale Anmeldungen</a
            >
          </li>
          <li>
            <a
              href="https://code.claude.com/docs/en/agent-sdk/overview"
              target="_blank"
              rel="noopener noreferrer"
              >Agent SDK: Einordnung und Authentifizierung</a
            >
          </li>
          <li>
            <a
              href="https://code.claude.com/docs/en/agent-sdk/quickstart"
              target="_blank"
              rel="noopener noreferrer"
              >TypeScript Agent SDK: Einstieg</a
            >
          </li>
          <li>
            <a
              href="https://code.claude.com/docs/en/agent-sdk/skills"
              target="_blank"
              rel="noopener noreferrer"
              >Skills im Agent SDK</a
            >
          </li>
          <li>
            <a
              href="https://code.claude.com/docs/en/agent-sdk/custom-tools"
              target="_blank"
              rel="noopener noreferrer"
              >Eigene Tools und SDK-MCP-Server</a
            >
          </li>
          <li>
            <a
              href="https://code.claude.com/docs/en/agent-sdk/permissions"
              target="_blank"
              rel="noopener noreferrer"
              >Berechtigungen und Hooks</a
            >
          </li>
          <li>
            <a
              href="https://obsidian.md/help/links"
              target="_blank"
              rel="noopener noreferrer"
              >Obsidian: Wikilinks, Überschriften und Blöcke</a
            >
          </li>
        </ul>
      </details>
    </section>
  </div>
</template>
