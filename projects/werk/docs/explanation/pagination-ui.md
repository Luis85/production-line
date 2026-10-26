# Bounded task, worker and event views

The orchestrator UI uses the [API pagination contract](../reference/api.md) for tasks, workers
and selected-task events. It requests at most 50 records per page and does not
follow continuation cursors automatically. Authentication probes request one
task; the Intake import summary samples the newest page of up to 50 tasks.

- **Tasks and workers:** Previous/Next replace the displayed page. Tasks are
  newest-created first; workers are newest-registered first. Heartbeats do not
  reorder worker pages. Counts describe this page, not the whole installation.
- **Task search and status:** apply only to the displayed page. A zero-match
  result does not mean no matching task exists elsewhere. Navigate pages or
  clear the filter to explore further; this UI does not provide global search.
- **Refresh:** “Neueste laden” returns to the first page. Live updates refresh
  only the current cursor every five seconds. Returning to or refreshing the
  first page starts a new traversal and includes newer insertions. Later pages
  keep their insertion watermark, while task and worker state can change.
- **Task events:** read up to 50 events oldest-first. Previous/Next replace the
  event page. “Ereignisse neu laden” restarts the traversal; later events require
  that new traversal. Events do not auto-page or auto-refresh.
- **Failures:** the last good page, cursor and draft remain available. Retry
  Previous/Next to repeat a failed page change, or restart with the refresh
  control. Invalid metadata, non-advancing cursors and oversized record counts
  are errors. There is no fallback to unbounded legacy endpoints.
- **Navigation:** the selected task remains independent of the table page.
  Newly saved tasks open from the POST response, even if their row is absent
  from the current page. Snapshot inspection and return to task use that same
  selected task. Authentication recovery clears all page and selection state.

The existing snapshot view remains separate: it loads at most the newest 10,000
snapshots, labels truncation, and derives its filters and summaries from those
records. Task/worker pages do not determine snapshot filter options or totals.

If the server includes a pinned `Task.context.commit`, the requirement reference
shows that commit and still identifies execution as simulated. A task without
that optional context remains explicitly unresolved. No manifest content is
fetched by this UI, and pinned context does not imply real provider execution or
Git publication.

Browser evidence: [desktop](../evidence/archive/pagination-desktop.png) and
[mobile](../evidence/archive/pagination-mobile.png). These captures use deterministic HTTP
fixtures to exercise page navigation, outage recovery and bounded collection
responses; they are not evidence of a production provider run.
