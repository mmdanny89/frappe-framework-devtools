// Agent that lives in the page (MAIN world). It detects the kind of page, hooks its events,
// answers the panel commands and tells the panel when the screen changes.
//
// The extension works only on development instances of Frappe 16 or later:
// the host must be in the manifest list, developer_mode must be on and Frappe must be 16+.
//
// Two modes:
//   desk: Frappe Desk. developer_mode and the version come from frappe.boot.
//   ui:   a frappe-ui app (Vue 3). These pages do not expose developer_mode or the version,
//         so the agent reads them from /desk with the same session.
//         A Guest cannot open /desk, so for a Guest the agent stays inactive.

(() => {
  const NS = (window.FrappeDevtools ??= {});
  if (NS.agent) return;

  const AGENT = "frappe-devtools-agent";
  const BRIDGE = "frappe-devtools-bridge";
  const READY_TIMEOUT_MS = 20000;
  const MIN_FRAPPE_MAJOR = 16;
  const PUSH_DELAY_MS = 250;
  // Safety net: Frappe events can come before the form has settled (form-refresh fires before
  // refresh_fields), and a message can get lost while Firefox restarts the background script.
  // So while a panel is open the agent rebuilds the tree on its own and sends it if it changed.
  const WATCH_INTERVAL_MS = 1500;

  class Agent {
    constructor() {
      this.state = "waiting";
      this.reason = "Waiting for Frappe Desk or a frappe-ui app to load…";
      this.mode = null;
      this.view = null; // { tree, inspector } of the current mode
      this.panelSeen = false;
      this.highlighter = new NS.Highlighter();
      this.picker = new NS.Picker(this);
      this.timeline = new NS.Timeline({ send: (msg) => this.send(msg), isLive: () => this.panelSeen });
    }

    start() {
      window.addEventListener("message", (event) => this.onMessage(event));
      this.waitForPage();
    }

    // Commands from the panel and the background script.
    handle(msg) {
      if (msg.type === "status") return this.sendStatus();
      // The last DevTools panel of this tab closed: stop everything that changes the page.
      if (msg.type === "panel-closed") {
        this.panelSeen = false;
        this.picker.stop();
        this.highlighter.hide();
        return;
      }
      // Any command proves that a panel is open, even if a "panel-closed" arrived out of order.
      this.panelSeen = true;
      if (msg.type === "hello") {
        this.sendStatus();
        if (this.state === "active") this.sendTree();
        return;
      }
      if (this.state !== "active") return this.sendStatus();
      switch (msg.type) {
        case "tree": return this.sendTree();
        case "inspect": return this.sendInspect(msg.id);
        case "highlight": return this.highlight(msg.id);
        case "pick": return msg.on ? this.startPicker() : this.picker.stop();
        case "info": return this.send({ type: "info", mode: this.mode, ...this.view.inspector.info() });
        case "action": return this.runAction(msg.id, msg.action, msg.confirmed === true);
        case "timeline": return this.send({ type: "timeline", events: this.timeline.all() });
        case "timeline-clear": return this.timeline.clear();
      }
    }

    waitForPage() {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const vueApp = findVueApp();
        if (isDeskReady()) {
          clearInterval(timer);
          this.activate(() => this.activateDesk());
        } else if (vueApp && isFrappeUiApp()) {
          clearInterval(timer);
          this.activate(() => this.activateUi(vueApp));
        } else if (Date.now() - startedAt > READY_TIMEOUT_MS) {
          clearInterval(timer);
          this.setState("inactive", "This is not a Frappe Desk page (/desk) or a frappe-ui app.");
        }
      }, 300);
    }

    // An error while hooking the page must not leave the agent waiting forever.
    activate(fn) {
      const fail = (e) => {
        console.error("[Frappe Framework DevTools]", e);
        this.setState("inactive", `The agent could not start: ${e.message}`);
      };
      try {
        Promise.resolve(fn()).catch(fail);
      } catch (e) {
        fail(e);
      }
    }

    activateDesk() {
      const problem = siteProblem({ developerMode: frappe.boot.developer_mode, version: frappe.boot.versions?.frappe });
      if (problem) return this.setState("inactive", problem);
      this.mode = "desk";
      NS.early?.disable(); // Desk calls come from the frappe.call hook
      this.view = { tree: new NS.ViewTree(), inspector: new NS.Inspector() };
      this.installDeskHooks();
      this.timeline.installDesk();
      this.becomeActive();
    }

    async activateUi(app) {
      this.setState("waiting", "Checking developer_mode and the Frappe version (/desk)…");
      const site = await readDeskBoot();
      const problem = site.problem || siteProblem(site);
      if (problem) return this.setState("inactive", problem);
      this.mode = "ui";
      const tree = new NS.UiTree(app);
      this.view = { tree, inspector: new NS.UiInspector(tree) };
      this.timeline.installUi(tree);
      this.installUiHooks(tree.router);
      this.becomeActive();
    }

    becomeActive() {
      this.setState("active", "");
      if (this.panelSeen) this.sendTree();
      setInterval(() => this.panelSeen && this.pushIfChanged(), WATCH_INTERVAL_MS);
    }

    installDeskHooks() {
      const push = () => this.schedulePush();
      frappe.router.on("change", push);
      $(document).on("form-load form-refresh form-rename form-unload", push);
      wrapAfter(frappe.model, "trigger", push); // value change of any field
      wrapAfter(frappe.ui.Dialog.prototype, "show", push);
      wrapAfter(frappe.ui.Dialog.prototype, "hide", push);
    }

    // Resources change state when a request starts or ends, so every call refreshes the tree.
    installUiHooks(router) {
      const push = () => this.schedulePush();
      router?.afterEach(push);
      NS.early.onResource = push;
      NS.early.onCall = (call) => {
        this.timeline.recordFetch(call);
        push();
      };
    }

    // Groups many events in a row into one tree update.
    schedulePush() {
      if (!this.panelSeen) return;
      clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => this.pushIfChanged(), PUSH_DELAY_MS);
    }

    // Sends the tree only if it differs from the last one the panel got.
    pushIfChanged() {
      const tree = this.view.tree.build();
      const json = JSON.stringify(tree);
      if (json === this.lastTreeJson) return;
      this.lastTreeJson = json;
      this.send({ type: "tree-changed", tree });
    }

    // The panel asked for the tree: always send it.
    sendTree() {
      const tree = this.view.tree.build();
      this.lastTreeJson = JSON.stringify(tree);
      this.send({ type: "tree", tree });
    }

    sendInspect(id) {
      const target = this.view.tree.resolve(id);
      if (!target) return this.send({ type: "inspect", id, missing: true });
      this.send({ type: "inspect", id, ...this.view.inspector.inspect(target) });
    }

    runAction(id, action, confirmed) {
      const target = this.view.tree.resolve(id);
      const result = target && this.view.inspector.action(target, action, confirmed);
      this.send({ type: "action-done", id, action, result });
      this.schedulePush();
    }

    highlight(id) {
      const target = id && this.view.tree.resolve(id);
      this.highlighter.show(target && this.view.inspector.element(target), id);
    }

    startPicker() {
      this.picker.start({
        onPick: (id) => this.send({ type: "picked", id }),
        onCancel: () => this.send({ type: "pick-cancelled" }),
      });
    }

    setState(state, reason) {
      this.state = state;
      this.reason = reason;
      // Not a supported development site: the early hooks stop recording anything.
      if (state === "inactive") NS.early?.disable();
      this.sendStatus();
    }

    // The background script also reads this message for the toolbar button and the popup.
    sendStatus() {
      const active = this.state === "active";
      this.send({
        type: "status",
        state: this.state,
        reason: this.reason,
        mode: this.mode,
        ...(active ? this.view.inspector.statusInfo() : {}),
      });
    }

    onMessage(event) {
      if (event.source !== window || event.data?.source !== BRIDGE) return;
      const msg = JSON.parse(event.data.json);
      try {
        this.handle(msg);
      } catch (e) {
        this.send({ type: "error", message: e.message, stack: e.stack, command: msg.type });
      }
    }

    send(msg) {
      window.postMessage({ source: AGENT, json: JSON.stringify(msg) }, location.origin);
    }
  }

  // Returns why the site is not supported, or null.
  function siteProblem({ developerMode, version }) {
    const major = parseInt(String(version || ""), 10);
    if (!major) return "Could not read the Frappe version of this site.";
    if (major < MIN_FRAPPE_MAJOR) {
      return `Frappe Framework DevTools needs Frappe ${MIN_FRAPPE_MAJOR} or later. This site runs Frappe ${version}.`;
    }
    if (!developerMode) return "developer_mode is off on this site. The extension works only on development instances.";
    return null;
  }

  // /desk embeds frappe.boot, with developer_mode and versions.frappe. A Guest is redirected to /login.
  //
  // Side effect to undo: opening /desk makes Frappe create a CSRF token in the session if it had none.
  // From then on Frappe checks the token on every POST. A page that had no token (for example
  // a frappe-ui app served by the Vite dev server) would start to fail with CSRFTokenError.
  // So, if the page has no valid token, the agent gives it the token that /desk just created.
  async function readDeskBoot() {
    const fetchFn = NS.early?.originalFetch || window.fetch;
    let response;
    try {
      response = await fetchFn.call(window, "/desk", { credentials: "same-origin", redirect: "manual" });
    } catch (e) {
      return { problem: `Could not open /desk to check developer_mode: ${e.message}` };
    }
    if (response.type === "opaqueredirect" || response.status >= 300) {
      return { problem: "Log in as a Desk user. In frappe-ui apps the extension reads developer_mode and the Frappe version from /desk, and a Guest cannot open it." };
    }
    const html = await response.text();
    adoptCsrfToken(html);
    return {
      developerMode: /"developer_mode":\s*(1|true)\b/.test(html),
      version: (html.match(/"versions":\{[^}]*?"frappe":"([^"]+)"/) || [])[1],
    };
  }

  function adoptCsrfToken(html) {
    const current = window.csrf_token;
    if (typeof current === "string" && current && !current.includes("{{")) return;
    const token = (html.match(/frappe\.csrf_token = "([^"{}]+)"/) || [])[1];
    if (token) window.csrf_token = token;
  }

  function isDeskReady() {
    return Boolean(window.frappe?.boot?.sitename && frappe.router && frappe.ui?.form && frappe.model);
  }

  // Vue 3 marks the mount element with data-v-app and keeps the app on __vue_app__.
  function findVueApp() {
    for (const el of document.querySelectorAll("[data-v-app]")) {
      if (el.__vue_app__) return el.__vue_app__;
    }
    return null;
  }

  // A Vue app talks to Frappe if it set the frappe-ui config (1.0+), has Frappe boot data,
  // or made calls to /api (0.1.x keeps its config private).
  function isFrappeUiApp() {
    return Boolean(NS.early?.configTouched || window.frappe?.boot || window.csrf_token || NS.early?.calls.length);
  }

  // Wraps a method to call `after` when it ends, without changing its result.
  function wrapAfter(obj, name, after) {
    const original = obj[name];
    obj[name] = function (...args) {
      const result = original.apply(this, args);
      after();
      return result;
    };
  }

  NS.agent = new Agent();
  NS.agent.start();
})();
