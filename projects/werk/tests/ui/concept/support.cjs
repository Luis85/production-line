const { pathToFileURL } = require("node:url");
const { join } = require("node:path");
async function simulation(saved) {
  const root = join(__dirname, "../../../src/orchestrator/webview/concept");
  const [{ createConceptSimulation }, { createConceptWorkspace }] =
    await Promise.all([
      import(pathToFileURL(join(root, "engine.mjs")).href),
      import(pathToFileURL(join(root, "workspace.mjs")).href),
    ]);
  const engine = createConceptSimulation(saved);
  return { engine, workspace: createConceptWorkspace(engine) };
}
module.exports = { simulation };
