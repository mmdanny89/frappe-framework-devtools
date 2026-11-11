// Toolbar button popup: tells if the current tab has Frappe Desk active, like the Vue DevTools popup.

const DEV_HOSTS = "localhost, 127.0.0.1, *.localhost, *.local or *.test";

class Popup {
  async start() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const { status, hasAgent } = await browser.runtime.sendMessage({ type: "get-status", tabId: tab.id });
    if (status) this.showStatus(status);
    else if (hasAgent) this.show("waiting", "Waiting for Frappe…", "Reload the page if this does not change.");
    else this.show("off", "Frappe not detected", `The extension works only on development hosts (${DEV_HOSTS}).`);
  }

  showStatus(status) {
    if (status.state === "active") {
      this.show("active", "Frappe detected", "Open DevTools (F12) and select the Frappe tab.");
      this.showDetails(status);
    } else if (status.state === "waiting") {
      this.show("waiting", "Waiting for Frappe Desk…", status.reason);
    } else {
      this.show("off", "Inactive", status.reason);
    }
  }

  show(state, title, hint) {
    document.getElementById("state").className = `state ${state}`;
    document.getElementById("state-text").textContent = title;
    document.getElementById("hint").textContent = hint || "";
  }

  showDetails({ site, user, version }) {
    document.getElementById("site").textContent = site;
    document.getElementById("user").textContent = user;
    document.getElementById("version").textContent = version;
    document.getElementById("details").hidden = false;
  }
}

new Popup().start();
