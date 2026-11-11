// Panel entry point. Gets the agent messages and hands them to the views.

const DEV_HOSTS = "localhost, 127.0.0.1, *.localhost, *.local, *.test";

class App {
  constructor() {
    this.selectedId = null;
    this.activeTab = "tree";
    this.connection = new Connection({
      onMessage: (msg) => this.onMessage(msg),
      onConnect: () => this.connection.send({ type: "hello" }),
    });
    this.tree = new TreeView($("tree"), {
      onSelect: (id) => this.select(id),
      onHover: (id) => this.connection.send({ type: "highlight", id }),
    });
    this.inspector = new InspectorView($("inspector"), {
      emptyText: EMPTY_TEXT.tree,
      onAction: (action, confirmed) => this.connection.send({ type: "action", id: this.selectedId, action, confirmed }),
    });
    this.info = new InfoView($("info"));
    this.calls = new CallsView({
      body: $("calls-body"),
      detail: $("call-detail"),
      filter: $("calls-filter"),
      errorsOnly: $("calls-errors"),
      clear: $("calls-clear"),
    });
    this.timeline = new TimelineView({
      body: $("timeline-body"),
      detail: $("timeline-detail"),
      filter: $("timeline-filter"),
      categories: $("timeline-categories"),
      pause: $("timeline-pause"),
      clear: $("timeline-clear"),
      onClear: () => this.connection.send({ type: "timeline-clear" }),
    });
  }

  start() {
    this.followTheme();
    this.bindToolbar();
    this.connection.connect();
    // Coming back to the Frappe tab of DevTools: ask for the current tree.
    document.addEventListener("visibilitychange", () => !document.hidden && this.connection.send({ type: "tree" }));
  }

  onMessage(msg) {
    switch (msg.type) {
      case "status": return this.setStatus(msg.state, msg.reason);
      case "no-page":
        return this.setStatus("inactive",
          `No agent in this tab. The host is not a development host (${DEV_HOSTS}), ` +
          "or the page was opened before the extension was installed or reloaded. Reload the page.");
      case "page-connected": return this.connection.send({ type: "hello" });
      case "page-disconnected": return this.setStatus("waiting", "The page is reloading…");
      case "tree":
      case "tree-changed": return this.onTree(msg.tree);
      case "inspect": return this.onInspect(msg);
      case "picked": return this.onPicked(msg.id);
      case "pick-cancelled": return this.setPicking(false);
      case "info": return this.info.render(msg);
      case "action-done": return this.connection.send({ type: "inspect", id: this.selectedId });
      case "timeline": return this.timeline.reset(msg.events);
      case "timeline-events": return this.timeline.add(msg.events);
      case "error": return this.showError(msg);
    }
  }

  setStatus(state, reason) {
    // When the agent becomes active (new panel or reloaded page), ask for the full timeline.
    if (state === "active" && document.body.dataset.state !== "active") {
      this.connection.send({ type: "timeline" });
    }
    document.body.dataset.state = state;
    $("status").textContent = reason || "";
    this.calls.enabled = state === "active";
  }

  onTree(nodes) {
    this.tree.render(nodes);
    // The tree changed (save, value change, depends_on…). Update the inspector too.
    if (this.selectedId) this.connection.send({ type: "inspect", id: this.selectedId });
  }

  onInspect(msg) {
    if (msg.id === this.selectedId) this.inspector.render(msg, this.tree.nodeById(msg.id));
  }

  onPicked(id) {
    this.setPicking(false);
    this.showTab("tree");
    this.select(id);
  }

  select(id) {
    this.selectedId = id;
    this.tree.select(id);
    this.connection.send({ type: "inspect", id });
  }

  bindToolbar() {
    document.querySelectorAll(".tabs button").forEach((b) =>
      b.addEventListener("click", () => this.showTab(b.dataset.tab))
    );
    $("pick").addEventListener("click", () => {
      const on = $("pick").getAttribute("aria-pressed") !== "true";
      this.setPicking(on);
      this.connection.send({ type: "pick", on });
    });
    $("refresh").addEventListener("click", () => this.refresh());
    $("tree-filter").addEventListener("input", (e) => this.tree.setFilter(e.target.value));
  }

  showTab(name) {
    this.activeTab = name;
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
    if (name === "info") this.connection.send({ type: "info" });
  }

  refresh() {
    this.connection.send({ type: "tree" });
    if (this.activeTab === "info") this.connection.send({ type: "info" });
  }

  setPicking(on) {
    $("pick").setAttribute("aria-pressed", String(on));
  }

  // Shows agent errors for a few seconds and logs them in the panel console.
  showError({ message, stack, command }) {
    console.error(`[Frappe Framework DevTools] ${command}: ${message}\n${stack}`);
    const bar = el("div", "error-bar", `Error in "${command}": ${message}`);
    document.body.insertBefore(bar, document.querySelector("main"));
    setTimeout(() => bar.remove(), 6000);
  }

  // The panel uses the same theme (light or dark) as DevTools.
  followTheme() {
    const apply = (theme) => (document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light");
    apply(browser.devtools.panels.themeName);
    browser.devtools.panels.onThemeChanged?.addListener(apply);
  }
}

function $(id) {
  return document.getElementById(id);
}

new App().start();
