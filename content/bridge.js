// Runs in the isolated content-script world.
// Passes messages between the agent (page world) and the background script.
// Data crosses the page boundary as JSON text, so Firefox Xray wrappers do not get in the way.

(() => {
  const AGENT = "frappe-devtools-agent";
  const BRIDGE = "frappe-devtools-bridge";

  class Bridge {
    start() {
      window.addEventListener("message", (event) => this.fromAgent(event));
      this.connect();
    }

    connect() {
      this.port = browser.runtime.connect({ name: "page" });
      this.port.onMessage.addListener((msg) => this.toAgent(msg));
      this.port.onDisconnect.addListener(() => {
        this.port = null;
        // Firefox unloaded the background page. Connect again.
        setTimeout(() => this.connect(), 500);
      });
    }

    // Any page script can post a message that looks like the agent's. Malformed ones are dropped.
    fromAgent(event) {
      if (event.source !== window || event.data?.source !== AGENT || typeof event.data.json !== "string") return;
      let msg;
      try {
        msg = JSON.parse(event.data.json);
      } catch (_) {
        return;
      }
      if (msg && typeof msg === "object" && typeof msg.type === "string") this.port?.postMessage(msg);
    }

    toAgent(msg) {
      window.postMessage({ source: BRIDGE, json: JSON.stringify(msg) }, location.origin);
    }
  }

  new Bridge().start();
})();
