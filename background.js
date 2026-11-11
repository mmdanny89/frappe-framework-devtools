// Routes messages between the page bridge and the DevTools panels of the same tab.
// It also enables the toolbar button only on tabs with Frappe active, and answers the popup.
// Firefox can unload this event page at any time. Both sides reconnect on their own.

class MessageRouter {
  constructor() {
    this.pages = new Map(); // tabId -> port of the bridge in that tab
    this.panels = new Map(); // tabId -> Set of panel ports
    this.statuses = new Map(); // tabId -> last "status" message from the agent
  }

  listen() {
    // Disabled by default, so Firefox dims the icon. It is enabled per tab when the agent is active.
    browser.action.disable();
    browser.runtime.onConnect.addListener((port) => {
      if (port.name === "page") this.registerPage(port);
      else if (port.name.startsWith("panel:")) this.registerPanel(port, Number(port.name.slice(6)));
    });
    browser.runtime.onMessage.addListener((msg) => this.onPopupMessage(msg));
    browser.tabs.onRemoved.addListener((tabId) => this.statuses.delete(tabId));
  }

  registerPage(port) {
    const tabId = port.sender.tab.id;
    this.pages.set(tabId, port);
    port.onMessage.addListener((msg) => {
      if (msg.type === "status") this.updateStatus(tabId, msg);
      this.toPanels(tabId, msg);
    });
    port.onDisconnect.addListener(() => {
      // A new page can connect before the old one disconnects. Keep the new one.
      if (this.pages.get(tabId) !== port) return;
      this.pages.delete(tabId);
      this.statuses.delete(tabId);
      this.toPanels(tabId, { type: "page-disconnected" });
    });
    // The state is lost when this background page unloads. Ask the agent again.
    port.postMessage({ type: "status" });
    this.toPanels(tabId, { type: "page-connected" });
  }

  registerPanel(port, tabId) {
    if (!this.panels.has(tabId)) this.panels.set(tabId, new Set());
    this.panels.get(tabId).add(port);
    port.onMessage.addListener((msg) => {
      const page = this.pages.get(tabId);
      if (page) page.postMessage(msg);
      else port.postMessage({ type: "no-page" });
    });
    port.onDisconnect.addListener(() => {
      const panels = this.panels.get(tabId);
      panels?.delete(port);
      // Without a panel nobody can stop the element picker, so tell the page.
      if (!panels?.size) this.pages.get(tabId)?.postMessage({ type: "panel-closed" });
    });
  }

  // Firefox resets the per-tab state on navigation. The new agent sets it again.
  updateStatus(tabId, status) {
    this.statuses.set(tabId, status);
    const active = status.state === "active";
    if (active) browser.action.enable(tabId);
    else browser.action.disable(tabId);
    browser.action.setTitle({
      tabId,
      title: active
        ? `Frappe Framework DevTools: ${status.site} (${status.version})`
        : `Frappe Framework DevTools: ${status.reason || "Frappe not detected"}`,
    });
  }

  // The popup asks for the state of its tab.
  onPopupMessage(msg) {
    if (msg?.type !== "get-status") return undefined;
    return Promise.resolve({
      status: this.statuses.get(msg.tabId) || null,
      hasAgent: this.pages.has(msg.tabId),
    });
  }

  toPanels(tabId, msg) {
    for (const port of this.panels.get(tabId) || []) port.postMessage(msg);
  }
}

new MessageRouter().listen();
