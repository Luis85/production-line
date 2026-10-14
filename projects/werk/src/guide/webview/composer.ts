export interface SystemDraft {
  id: string;
  factory: string;
  factoryPort: string | number;
  line: string;
  project: string;
  port: string | number;
  workers: string | number;
  workerPort: string | number;
}
export function validateDefinition(draft: SystemDraft): string {
  const id = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (!id.test(draft.id.trim()) || !id.test(draft.line.trim()))
    return "Use lowercase hyphen-separated system and line IDs.";
  if (reserved.test(draft.id.trim()) || reserved.test(draft.line.trim()))
    return "System and line IDs cannot use reserved device names.";
  if (draft.id.trim().length > 55 || draft.line.trim().length > 63)
    return "System ID: at most 55 characters; line ID: at most 63.";
  if (!draft.factory.trim() || draft.factory.length > 100 || /[\x00-\x1f\x7f]/.test(draft.factory))
    return "Enter a Factory name with at most 100 characters and no control characters.";
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(draft.project.trim()))
    return "Use letters, digits, underscores or hyphens for the project ID.";
  const count = Number(draft.workers),
    first = Number(draft.workerPort);
  if (!Number.isInteger(count) || count < 1 || count > 8)
    return "Choose between one and eight worker processes.";
  const ports = [
    Number(draft.factoryPort),
    Number(draft.port),
    ...Array.from({ length: count }, (_, index) => first + index),
  ];
  if (
    ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535)
  )
    return "Service ports and the worker port range must stay between 1024 and 65535.";
  if (new Set(ports).size !== ports.length)
    return "Each service needs a distinct port. Worker ports occupy a consecutive range.";
  return "";
}
export function renderDefinition(
  draft: SystemDraft,
  environment: "native" | "docker",
): string {
  const error = validateDefinition(draft);
  if (error) throw Error(error);
  const quote = (value: string) => JSON.stringify(value.trim());
  return [
    "schemaVersion: 1",
    "id: " + quote(draft.id),
    "environment: " + environment,
    "factory:",
    "  id: " + quote(draft.id + "-factory"),
    "  name: " + quote(draft.factory),
    "  port: " + Number(draft.factoryPort),
    "productionLines:",
    "  - id: " + quote(draft.line),
    "    name: " + quote(draft.line),
    "    project: " + quote(draft.project),
    "    orchestrator:",
    "      port: " + Number(draft.port),
    "    workers:",
    "      count: " + Number(draft.workers),
    "      statusPort: " + Number(draft.workerPort),
    "",
  ].join("\n");
}
