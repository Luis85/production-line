<template>
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
</template>
