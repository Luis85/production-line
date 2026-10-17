/* Pure, local-only concept simulation. No network, provider, DOM or Git operations. */
export const projects = [
  {
    id: "atlas",
    name: "Atlas ERP",
    team: "Team Enterprise",
    stack: "Vue · Node.js · PostgreSQL",
    repo: "enterprise/atlas-erp",
    color: "#8be0b8",
  },
  {
    id: "portal",
    name: "Kundenportal",
    team: "Team Experience",
    stack: "React · Node.js · REST",
    repo: "experience/kundenportal",
    color: "#81b6ee",
  },
  {
    id: "field",
    name: "Field Service",
    team: "Team Operations",
    stack: "Angular · NestJS · PostgreSQL",
    repo: "operations/field-service",
    color: "#edc47e",
  },
];
export const states = [
  "queued",
  "running",
  "checks",
  "review",
  "changes",
  "blocked",
  "done",
];
export const labels = {
  queued: "Warteschlange",
  running: "Umsetzung",
  checks: "Qualitätsprüfung",
  review: "PR / Review",
  changes: "Nacharbeit",
  blocked: "Klärung",
  done: "Abgeschlossen",
};
export const project = (id) => projects.find((p) => p.id === id),
  active = (t) => ["running", "checks"].includes(t.status),
  waiting = (t) => ["queued", "changes"].includes(t.status);
export const demoCommits = {
  atlas: "a".repeat(40),
  portal: "b".repeat(40),
  field: "c".repeat(40),
};
export const STORAGE_KEY = "werk-factory-v1";
