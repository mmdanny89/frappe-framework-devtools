// Connects the panel to the agent of the inspected tab, through the background script.

class Connection {
  // onMessage(msg) gets each message. onConnect() runs on every (re)connection.
  constructor({ onMessage, onConnect }) {
    this.tabId = browser.devtools.inspectedWindow.tabId;
    this.onMessage = onMessage;
    this.onConnect = onConnect;
  }

  connect() {
    this.port = browser.runtime.connect({ name: `panel:${this.tabId}` });
    this.port.onMessage.addListener((msg) => this.onMessage(msg));
    this.port.onDisconnect.addListener(() => {
      this.port = null;
      // Firefox unloaded the background page. Connect again.
      setTimeout(() => this.connect(), 500);
    });
    this.onConnect();
  }

  send(msg) {
    this.port?.postMessage(msg);
  }
}
