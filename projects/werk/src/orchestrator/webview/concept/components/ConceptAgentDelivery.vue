<template>
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
</template>
