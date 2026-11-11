"""Tests the Frappe Framework DevTools agent on a real frappe-ui app, without Firefox.

early.js is injected before the page scripts (like document_start in Firefox).
The other agent scripts are injected after load. The test sends the agent the
same commands as the panel. It does not save documents.

First it opens the app as Guest: the agent must stay inactive, because a Guest
cannot open /desk to prove developer_mode and the Frappe version. Then it logs in
and checks everything else.

Environment variables:
  UI_URL           app URL (default http://mysite.local:8000/helpdesk)
  UI_HOST_MAP      Chromium rule to resolve the host (default "MAP mysite.local 127.0.0.1")
  FRAPPE_USER      Desk user (default Administrator)
  FRAPPE_PWD       password (required)
  CHROMIUM_PATH    Chromium executable (optional)
"""
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

EXT = Path(__file__).resolve().parent.parent
# The same scripts, in the same order, as the manifest loads at document_idle.
AGENT_FILES = [Path(p).stem for p in json.loads((EXT / "manifest.json").read_text())["content_scripts"][2]["js"]]
URL = os.environ.get("UI_URL", "http://mysite.local:8000/helpdesk")
HOST_MAP = os.environ.get("UI_HOST_MAP", "MAP mysite.local 127.0.0.1")

COLLECT = """
window.__msgs = [];
window.addEventListener("message", (e) => {
  if (e.data?.source === "frappe-devtools-agent") window.__msgs.push(JSON.parse(e.data.json));
});
"""

failures = []


def check(cond, label):
    print(("OK   " if cond else "FAIL ") + label)
    if not cond:
        failures.append(label)


def send(page, msg, wait_type, timeout=4000):
    page.evaluate("window.__msgs = []")
    page.evaluate("(m) => postMessage({source: 'frappe-devtools-bridge', json: JSON.stringify(m)}, location.origin)", msg)
    page.wait_for_function("(t) => __msgs.some(m => m.type === t || m.type === 'error')", arg=wait_type, timeout=timeout)
    msgs = page.evaluate("__msgs")
    errors = [m for m in msgs if m["type"] == "error"]
    if errors:
        print("  agent error:", errors[0]["message"], errors[0]["stack"][:400])
    return next((m for m in msgs if m["type"] == wait_type), errors[0] if errors else None)


def walk(nodes):
    for n in nodes:
        yield n
        yield from walk(n.get("children", []))


def login(page):
    base = "{0.scheme}://{0.netloc}".format(urlsplit(URL))
    page.goto(f"{base}/login")
    status = page.evaluate("""([usr, pwd]) => fetch('/api/method/login', {method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({usr, pwd})}).then(r => r.status)""",
        [os.environ.get("FRAPPE_USER", "Administrator"), os.environ["FRAPPE_PWD"]])
    print("login:", status)


def open_app(browser, logged_in):
    page = browser.new_context().new_page()
    page.set_viewport_size({"width": 1400, "height": 900})
    page.errors = []
    page.on("pageerror", lambda e: (page.errors.append(str(e)), print("  pageerror:", e)))
    page.add_init_script(path=str(EXT / "agent" / "early.js"))
    page.add_init_script(COLLECT)
    if logged_in:
        login(page)
    page.goto(URL)
    page.wait_for_function("document.querySelector('[data-v-app]')?.__vue_app__", timeout=20000)
    page.wait_for_timeout(1500)
    for name in AGENT_FILES:
        page.add_script_tag(path=str(EXT / "agent" / f"{name}.js"))
    page.wait_for_function("['active', 'inactive'].includes(window.FrappeDevtools?.agent?.state)", timeout=15000)
    return page


def check_guest(browser):
    try:
        page = open_app(browser, logged_in=False)
    except Exception:
        print("  Guest: the app does not load without a session (it sends Guests to the login page)")
        return
    state, reason, recording = page.evaluate("[FrappeDevtools.agent.state, FrappeDevtools.agent.reason, FrappeDevtools.early.recording]")
    check(state == "inactive" and "Log in as a Desk user" in reason, f"Guest: agent inactive, developer_mode cannot be checked ({reason[:60]})")
    check(recording is False, "Guest: the early hooks stop recording")
    page.close()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH"), args=[f"--host-resolver-rules={HOST_MAP}"])
        check_guest(browser)
        page = open_app(browser, logged_in=True)

        state = page.evaluate("[FrappeDevtools.agent.state, FrappeDevtools.agent.mode, FrappeDevtools.agent.reason]")
        check(state[:2] == ["active", "ui"], f"agent active in frappe-ui mode: {state}")
        status = send(page, {"type": "status"}, "status")
        print("  status:", {k: status.get(k) for k in ("site", "user", "version")})
        check("Vue" in (status.get("version") or ""), "status reports the Vue version")
        # frappe-ui 1.0+ keeps its config in a global that early.js hooks. 0.1.x keeps it private.
        modern = page.evaluate("FrappeDevtools.early.configTouched")
        print("  frappe-ui config:", "global (1.0+)" if modern else "private (0.1.x): no Resource requests by design")

        tree = send(page, {"type": "hello"}, "tree")["tree"]
        kinds = sorted({n["kind"] for n in walk(tree)})
        print("  kinds:", kinds)
        check({"live", "requests"} <= set(kinds), "tree has live resources and resource requests")
        requests = next(n for n in tree if n["id"] == "ui/requests")
        print("  requests:", [(c["label"], c["detail"]) for c in requests["children"]][:8])
        if modern:
            check(len(requests["children"]) > 0, f"resourceFetcher requests seen: {len(requests['children'])}")
        else:
            check(len(requests["children"]) == 0 and "1.0+" in requests["detail"], "0.1.x: Resource requests explains it needs frappe-ui 1.0+")
        live = next(n for n in tree if n["id"] == "ui/live")
        print("  live:", live["detail"], [(o["label"], o["kind"], [r["label"] for r in o["children"]]) for o in live["children"]][:8])

        bad = []
        for n in walk(tree):
            res = send(page, {"type": "inspect", "id": n["id"]}, "inspect")
            if not res or res["type"] == "error" or res.get("missing"):
                bad.append(n["id"])
        check(not bad, f"inspect without errors on all nodes ({len(list(walk(tree)))}) {bad[:5]}")

        req = requests["children"][0] if requests["children"] else None
        if req:
            res = send(page, {"type": "inspect", "id": req["id"]}, "inspect")
            print("  request sections:", [s["title"] for s in res["sections"]])

        resources = [n for n in walk(tree) if n["kind"] == "resource"]
        if resources:
            res = send(page, {"type": "inspect", "id": resources[0]["id"]}, "inspect")
            check(res.get("actions") and "$resource" in res["consoleVars"], f"live resource has Reload and $resource ({resources[0]['label']})")
            done = send(page, {"type": "action", "id": resources[0]["id"], "action": "reload"}, "action-done")
            check(done.get("result") == "Reload started", "Reload action runs")
        else:
            print("  (no live resources reachable in this build)")

        owner = next((n for n in walk(tree) if n["kind"] == "component"), None)
        if owner:
            picked = page.evaluate("""(id) => {
                const a = FrappeDevtools.agent;
                const el = a.view.inspector.element(a.view.tree.resolve(id));
                return el && a.picker.idFromElement(el.querySelector('*') || el);
            }""", owner["id"])
            check(picked == owner["id"], f"picker maps an element to its component ({owner['label']}): {picked}")
        else:
            print("  (no component owners: production build, picker needs a development build)")

        info = send(page, {"type": "info"}, "info")
        print("  info:", info["summary"])
        check(info["mode"] == "ui" and info["summary"].get("vue"), "info tab in frappe-ui mode")

        events = send(page, {"type": "timeline"}, "timeline")["events"]
        calls = [e for e in events if e["cat"] == "call"]
        print("  calls:", [(e["title"], e["detail"]) for e in calls][:8])
        check(len(calls) > 0, f"timeline has the calls made while the app booted: {len(calls)}")
        check(all(e.get("stack") is not None for e in calls), "calls carry a JS stack")

        target = page.evaluate("""() => {
            const r = document.querySelector('[data-v-app]').__vue_app__.config.globalProperties.$router;
            const now = r.currentRoute.value.path;
            // A plain page: no params, no redirects, nothing about payments, checkout or accounts.
            const risky = /pay|checkout|cart|cancel|delete|logout|login|signup|account/i;
            const next = r.getRoutes().find(x => !x.path.includes(':') && x.path !== now && !x.redirect && !risky.test(x.path));
            if (!next) return null;
            r.push(next.path);
            return next.path;
        }""")
        page.wait_for_timeout(1500)
        if target:
            events = send(page, {"type": "timeline"}, "timeline")["events"]
            check(any(e["cat"] == "route" for e in events), f"route change in the timeline ({target})")
        # The /desk check must not break the app's POST requests (see adoptCsrfToken in agent.js).
        csrf = [e for e in page.errors if "CSRFTokenError" in e]
        check(not csrf, f"the app's requests keep working after the /desk check ({len(csrf)} CSRF errors)")
        page.screenshot(path="/tmp/frappe-devtools-ui.png")
        browser.close()
    print("\nFAILURES:" if failures else "\nAll OK", failures or "")
    sys.exit(1 if failures else 0)


main()
