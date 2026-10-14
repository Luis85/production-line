export const conceptViews = [
  "intake",
  "factory",
  "architecture",
  "process",
  "board",
  "dashboard",
  "providers",
  "operations",
  "system",
];
/** Local presentation state. Methods use their receiver so Vue can react to every change. */
export function createConceptWorkspace(engine) {
  return {
    view: "intake",
    currentLineId: engine.currentLineId,
    filter: engine.filter,
    query: "",
    statusFilter: "all",
    selected: "orchestrator",
    factoryMapLineId: null,
    playing: false,
    drafts: {},
    getDraft(lineId = this.currentLineId) {
      if (!engine.data.lines.some((line) => line.id === lineId))
        throw Error("Produktionslinie fehlt");
      return (this.drafts[lineId] ??= {
        title: "",
        criteria: "",
        links: "",
        provider: "auto",
        priority: 1,
        vaultRef: "",
        manualOpen: false,
      });
    },
    chooseLine(id) {
      const line = engine.chooseLine(id);
      this.currentLineId = id;
      this.filter = line.projectId;
      this.query = "";
      this.statusFilter = "all";
      this.selected = "orchestrator";
      this.playing = false;
      return line;
    },
    navigate(view) {
      if (!conceptViews.includes(view)) throw Error("Unbekannte Ansicht");
      this.playing = false;
      this.view = view;
    },
    newFeature() {
      this.navigate("intake");
      this.getDraft().manualOpen = true;
    },
    openProjectBoard(projectId, status = "all") {
      if (
        ![
          "all",
          "queued",
          "running",
          "checks",
          "review",
          "changes",
          "blocked",
          "done",
        ].includes(status)
      )
        throw Error("Ungültige Taskboard-Auswahl");
      this.chooseLine(engine.lineForProject(projectId).id);
      this.navigate("board");
      this.statusFilter = status;
    },
    selectFactoryMapLine(id) {
      if (!engine.data.lines.some((line) => line.id === id))
        throw Error("Produktionslinie fehlt");
      this.factoryMapLineId = id;
    },
    reset() {
      this.drafts = {};
      this.factoryMapLineId = null;
      this.chooseLine(engine.data.selectedLineId);
      this.navigate("intake");
    },
  };
}
