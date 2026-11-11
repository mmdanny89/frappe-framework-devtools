// Tests background.js with a fake `browser` object. Run: node tests/test_background.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";

const failures = [];
function check(cond, label) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}`);
  if (!cond) failures.push(label);
}

// A fake runtime port: messages posted to it are recorded, and the test can deliver messages to its listeners.
function fakePort(name, sender = {}) {
  const port = {
    name, sender, sent: [],
    listeners: { message: [], disconnect: [] },
    onMessage: { addListener: (fn) => port.listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => port.listeners.disconnect.push(fn) },
    postMessage: (msg) => port.sent.push(msg),
    deliver: (msg) => port.listeners.message.forEach((fn) => fn(msg)),
    disconnect: () => port.listeners.disconnect.forEach((fn) => fn()),
  };
  return port;
}

const calls = { enable: [], disable: [], titles: [] };
const listeners = {};
const browser = {
  runtime: {
    onConnect: { addListener: (fn) => (listeners.connect = fn) },
    onMessage: { addListener: (fn) => (listeners.message = fn) },
  },
  tabs: { onRemoved: { addListener: (fn) => (listeners.removed = fn) } },
  action: {
    enable: (tabId) => calls.enable.push(tabId),
    disable: (tabId) => calls.disable.push(tabId ?? "all"),
    setTitle: ({ tabId, title }) => calls.titles.push([tabId, title]),
  },
};

const source = readFileSync(new URL("../background.js", import.meta.url), "utf8");
vm.runInNewContext(source, { browser, console });

check(calls.disable.includes("all"), "toolbar button starts disabled for every tab");

const page1 = fakePort("page", { tab: { id: 1 } });
const panel1 = fakePort("panel:1", { url: "moz-extension://x/panel/panel.html" });
const panel2 = fakePort("panel:2", { url: "moz-extension://x/panel/panel.html" });
listeners.connect(panel1);
listeners.connect(panel2);
listeners.connect(page1);

check(panel1.sent.some((m) => m.type === "page-connected"), "panel of tab 1 hears that its page connected");
check(page1.sent.some((m) => m.type === "status"), "background asks the new page for its status");

page1.deliver({ type: "tree", tree: [] });
check(panel1.sent.some((m) => m.type === "tree"), "page messages reach the panel of the same tab");
check(!panel2.sent.some((m) => m.type === "tree"), "page messages never reach the panel of another tab");

panel1.deliver({ type: "inspect", id: "form" });
check(page1.sent.some((m) => m.type === "inspect"), "panel commands reach the page of the same tab");
panel2.deliver({ type: "inspect", id: "form" });
check(panel2.sent.some((m) => m.type === "no-page") && page1.sent.filter((m) => m.type === "inspect").length === 1,
  "a panel without a page gets no-page, and nothing reaches another tab");

page1.deliver({ type: "status", state: "active", site: "s.local", version: "Frappe 16.52.0" });
check(calls.enable.includes(1), "an active agent enables the toolbar button for its tab");
check(calls.titles.some(([t, title]) => t === 1 && title.includes("s.local")), "the button title names the site");
const reply = await listeners.message({ type: "get-status", tabId: 1 });
check(reply.status?.site === "s.local" && reply.hasAgent, "the popup gets the status of its tab");
page1.deliver({ type: "status", state: "inactive", reason: "developer_mode is off" });
check(calls.disable.includes(1), "an inactive agent disables the toolbar button for its tab");

const page1b = fakePort("page", { tab: { id: 1 } });
listeners.connect(page1b);
page1.disconnect();
panel1.deliver({ type: "tree" });
check(page1b.sent.some((m) => m.type === "tree"), "a reloaded page keeps its connection when the old one disconnects late");

panel1.disconnect();
check(page1b.sent.some((m) => m.type === "panel-closed"), "closing the last panel tells the page (stops the picker)");

console.log(failures.length ? `\nFAILURES: ${failures.length}` : "\nAll OK");
process.exit(failures.length ? 1 : 0);
