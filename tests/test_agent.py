"""Tests the Frappe Framework DevTools agent on a real v16 Desk, without Firefox.

Injects the agent scripts into the page and simulates the bridge: it sends commands
with postMessage and collects the answers. Read-only. It does not save documents.

Environment variables:
  FRAPPE_URL       site URL (default http://mysite.local:8000)
  FRAPPE_HOST_MAP  Chromium rule to resolve the host (default "MAP mysite.local 127.0.0.1")
  FRAPPE_USER      user (default Administrator)
  FRAPPE_PWD       password (required)
  CHROMIUM_PATH    Chromium executable (optional)
  TEST_OUT         folder for the highlight screenshot (default /tmp)
"""
import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

EXT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get("TEST_OUT", "/tmp"))
# The same scripts, in the same order, as the manifest loads at document_idle.
AGENT_FILES = [Path(p).stem for p in json.loads((EXT / "manifest.json").read_text())["content_scripts"][2]["js"]]
AGENT_FILES = ["early", *AGENT_FILES]  # injected after load here, so early.js goes too
BASE = os.environ.get("FRAPPE_URL", "http://mysite.local:8000")
HOST_MAP = os.environ.get("FRAPPE_HOST_MAP", "MAP mysite.local 127.0.0.1")

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


def send(page, msg, wait_type, timeout=3000):
    page.evaluate("window.__msgs = []")
    page.evaluate(
        "(m) => window.postMessage({source: 'frappe-devtools-bridge', json: JSON.stringify(m)}, location.origin)",
        msg,
    )
    page.wait_for_function(
        "(t) => window.__msgs.some(m => m.type === t || m.type === 'error')", arg=wait_type, timeout=timeout
    )
    msgs = page.evaluate("window.__msgs")
    errors = [m for m in msgs if m["type"] == "error"]
    if errors:
        print("  agent error:", errors[0]["message"], errors[0]["stack"][:400])
    return next((m for m in msgs if m["type"] == wait_type), errors[0] if errors else None)


def walk(nodes):
    for n in nodes:
        yield n
        yield from walk(n.get("children", []))


def inject(page):
    page.evaluate(COLLECT)
    for name in AGENT_FILES:
        page.add_script_tag(path=str(EXT / "agent" / f"{name}.js"))
    page.wait_for_function("window.FrappeDevtools?.agent?.state !== 'waiting'", timeout=10000)


def inspect_all(page, tree, label):
    bad = []
    for n in walk(tree):
        res = send(page, {"type": "inspect", "id": n["id"]}, "inspect")
        if not res or res["type"] == "error" or res.get("missing"):
            bad.append(n["id"])
    check(not bad, f"{label}: inspect without errors on all nodes ({len(list(walk(tree)))}) {bad[:5]}")


def goto(page, route):
    page.evaluate(f"frappe.set_route({json.dumps(route)})")
    page.wait_for_timeout(1500)


def last_form(page):
    trees = [m for m in page.evaluate("window.__msgs") if m["type"] in ("tree", "tree-changed")]
    form = next((n for n in (trees[-1]["tree"] if trees else []) if n["kind"] == "form"), None)
    return form and (form["detail"], form["label"])


def check_navigation(page):
    """The tree must follow the route, also after an out-of-order panel-closed and without Frappe events."""
    names = page.evaluate("frappe.db.get_list('User', {fields: ['name'], limit: 2}).then(r => r.map(x => x.name))")
    for doctype, name in [("ToDo", None), ("User", names[0]), ("User", names[-1]), ("back", None)]:
        page.evaluate("window.__msgs = []")
        if doctype == "back":
            page.evaluate("history.back()")
        elif name is None:
            page.evaluate(f"frappe.set_route('Form', '{doctype}', 'new')")
        else:
            page.evaluate(f"frappe.set_route('Form', '{doctype}', {json.dumps(name)})")
        page.wait_for_timeout(2500)
        route = page.evaluate("frappe.get_route()")
        expected = (route[1], page.evaluate("cur_frm.docname"))
        check(last_form(page) == expected, f"navigation: tree follows the route {route[:3]} -> {last_form(page)}")

    # A panel-closed that arrives late must not silence the agent while the panel is still open.
    page.evaluate("postMessage({source: 'frappe-devtools-bridge', json: JSON.stringify({type: 'panel-closed'})}, location.origin)")
    page.wait_for_timeout(100)
    send(page, {"type": "inspect", "id": "form"}, "inspect")
    other = next(n for n in names if n != page.evaluate("cur_frm.docname"))  # a route that really changes
    page.evaluate("window.__msgs = []")
    page.evaluate(f"frappe.set_route('Form', 'User', {json.dumps(other)})")
    page.wait_for_timeout(2500)
    check(last_form(page) == ("User", other), "navigation: any panel command after a late panel-closed restores updates")

    # The watcher sends changes that came without any Frappe event.
    page.evaluate("window.__msgs = []")
    page.evaluate("cur_frm.fields_dict.middle_name.df.reqd = 1")  # no Frappe event at all
    page.wait_for_timeout(2000)
    changed = [m for m in page.evaluate("window.__msgs") if m["type"] == "tree-changed"]
    check(bool(changed), "navigation: the watcher sends a change that had no Frappe event")
    page.evaluate("cur_frm.fields_dict.middle_name.df.reqd = 0")


def check_timeline(page):
    status = send(page, {"type": "status"}, "status")
    check(status["state"] == "active" and status["site"] and status["version"], f"status for the toolbar button: {status.get('site')} {status.get('version')}")

    goto(page, ["Form", "ToDo", "new"])
    page.wait_for_function("cur_frm?.doctype === 'ToDo'")
    page.evaluate("""() => {
        function changeDescription() { cur_frm.set_value('description', 'timeline (not saved)'); }
        changeDescription();
        frappe.call({method: 'frappe.client.get_count', args: {doctype: 'ToDo'}});
        frappe.call({method: 'frappe.client.get', args: {doctype: 'ToDo', name: 'frappe-devtools-test-missing'}});
        frappe.msgprint({message: '<b>Hello</b>', title: 'Test', indicator: 'orange'});
    }""")
    page.wait_for_timeout(2500)
    page.evaluate("cur_dialog && cur_dialog.hide()")
    page.wait_for_timeout(300)
    events = send(page, {"type": "timeline"}, "timeline")["events"]
    cats = {e["cat"] for e in events}
    check({"route", "form", "field", "call", "dialog", "msg"} <= cats, f"timeline categories: {sorted(cats)}")

    field = next((e for e in reversed(events) if e["cat"] == "field" and e["title"] == "ToDo.description"), None)
    check(field and field["data"]["new"] == "timeline (not saved)", f"field change: {field and field['detail']}")
    check(field and "changeDescription" in (field["stack"] or ""), "the change stack includes the calling function")

    ok_call = next((e for e in events if e["cat"] == "call" and e["title"] == "frappe.client.get_count"), None)
    check(ok_call and ok_call["level"] == "info" and isinstance(ok_call["data"]["response"], int), f"successful call: {ok_call and ok_call['detail']}")
    bad_call = next((e for e in events if e["cat"] == "call" and e["title"] == "frappe.client.get" and e["level"] == "error"), None)
    check(bad_call and bad_call["level"] == "error", f"failed call: {bad_call and bad_call['detail']}")

    msg = next((e for e in events if e["cat"] == "msg" and "Hello" in e["title"]), None)
    check(msg and msg["level"] == "warn" and "<" not in msg["title"], f"msgprint without HTML: {msg and msg['title']}")
    # Frappe does render HTML in its dialog. This tests only the extension's cleaner.
    page.evaluate("""FrappeDevtools.agent.timeline.recordMessage(
        {message: '<img src=x onerror="window.__xss=1">text'}, 'test')""")
    page.wait_for_timeout(500)
    check(not page.evaluate("window.__xss"), "the message cleaner does not run HTML")
    dialogs = [e["detail"] for e in events if e["cat"] == "dialog"]
    check("opened" in dialogs and "closed" in dialogs, f"dialogs opened and closed: {dialogs}")

    page.evaluate("window.__msgs = []")
    page.evaluate("cur_frm.set_value('description', 'live')")
    page.wait_for_function("window.__msgs.some(m => m.type === 'timeline-events')", timeout=3000)
    check(True, "live events (timeline-events) after a change")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH"), args=[f"--host-resolver-rules={HOST_MAP}"])
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.on("pageerror", lambda e: print("  pageerror:", e))
        page.goto(f"{BASE}/login")
        status = page.evaluate("""([usr, pwd]) => fetch('/api/method/login', {method: 'POST',
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            body: new URLSearchParams({usr, pwd})}).then(r => r.status)""", [os.environ.get("FRAPPE_USER", "Administrator"), os.environ["FRAPPE_PWD"]])
        print("login:", status)
        page.goto(f"{BASE}/desk/user/Administrator")
        page.wait_for_function("window.cur_frm?.doctype === 'User'", timeout=20000)
        print("site:", page.evaluate("frappe.boot.sitename"), "· frappe", page.evaluate("frappe.boot.versions.frappe"))
        inject(page)

        hello = send(page, {"type": "hello"}, "tree")
        tree = hello["tree"]
        kinds = {n["kind"] for n in walk(tree)}
        check({"route", "form", "tab", "section", "field", "meta", "meta-cache"} <= kinds, f"form tree: {sorted(kinds)}")
        check(page.evaluate("FrappeDevtools.agent.state") == "active", "agent active with developer_mode")
        inspect_all(page, tree, "Form User")

        res = send(page, {"type": "inspect", "id": "form/field/email"}, "inspect")
        check(res["sections"][0]["value"] == "admin@example.com" or bool(res["sections"][0]["value"]), f"email value: {res['sections'][0]['value']}")
        check(page.evaluate("window.$df?.fieldname") == "email", "$df exposed in the console")
        check("$frm" in res["consoleVars"], f"consoleVars: {res['consoleVars']}")

        meta = send(page, {"type": "inspect", "id": "form/meta"}, "inspect")
        check(meta["sections"][0].get("table") and len(meta["sections"][0]["table"]) > 10, f"meta: fields table ({meta['sections'][0]['title']})")

        # Picker: id of a field element and of a child table row
        pid = page.evaluate("""() => {
            const el = cur_frm.fields_dict.email.$wrapper.find('input, .control-value')[0] || cur_frm.fields_dict.email.$wrapper[0];
            return FrappeDevtools.agent.picker.idFromElement(el);
        }""")
        check(pid == "form/field/email", f"picker on email -> {pid}")
        row_id = page.evaluate("""() => {
            const t = Object.values(cur_frm.fields_dict).find(c => c.grid && c.grid.grid_rows?.length);
            if (!t) return 'no table with rows';
            const r = t.grid.grid_rows[0];
            return FrappeDevtools.agent.picker.idFromElement(r.wrapper.find('.static-area, .row-index')[0] || r.wrapper[0]);
        }""")
        check(row_id.startswith("form/row/") or row_id == "no table with rows", f"picker on row -> {row_id}")

        page.evaluate("window.postMessage({source:'frappe-devtools-bridge', json: JSON.stringify({type:'highlight', id:'form/field/email'})}, location.origin)")
        page.wait_for_timeout(300)
        check(page.evaluate("FrappeDevtools.agent.highlighter.box?.style.display") == "block", "highlight visible")
        page.screenshot(path=str(OUT / "frappe-devtools-highlight.png"))

        info = send(page, {"type": "info"}, "info")
        check(info["summary"]["developer_mode"] in (1, True), f"info: {info['summary']}")

        # New ToDo, not saved: opening it sends a tree with the new form (the agent sends only changed trees)
        page.evaluate("window.__msgs = []")
        goto(page, ["Form", "ToDo", "new"])
        page.wait_for_function("cur_frm?.doctype === 'ToDo'")
        page.evaluate("cur_frm.set_value('description', 'devtools test (not saved)')")
        page.wait_for_function("window.__msgs.some(m => m.type === 'tree-changed' && m.tree.some(n => n.detail === 'ToDo'))", timeout=4000)
        changed = [m for m in page.evaluate("window.__msgs") if m["type"] == "tree-changed"][-1]
        form = next(n for n in changed["tree"] if n["kind"] == "form")
        check(form["detail"] == "ToDo" and "new" in form["flags"], f"tree-changed for the new ToDo: {form['label']} {form['flags']}")
        inspect_all(page, changed["tree"], "New ToDo form")

        # List
        goto(page, ["List", "ToDo"])
        tree = send(page, {"type": "tree"}, "tree")["tree"]
        check(any(n["kind"] == "list" for n in tree) and not any(n["kind"] == "form" for n in tree), "list detected and no stale form")
        inspect_all(page, tree, "List ToDo")

        # Dialog
        page.evaluate("window.__d = new frappe.ui.Dialog({title: 'Test', fields: [{fieldname: 'x', fieldtype: 'Data', label: 'X'}]}); __d.show()")
        page.wait_for_timeout(600)
        tree = send(page, {"type": "tree"}, "tree")["tree"]
        dialog = next((n for n in tree if n["kind"] == "dialog"), None)
        check(dialog and dialog["children"][0]["id"] == "dialog/0/field/x", f"dialog in the tree: {dialog and dialog['label']}")
        inspect_all(page, tree, "Dialog")
        pid = page.evaluate("FrappeDevtools.agent.picker.idFromElement(__d.fields_dict.x.$input[0])")
        check(pid == "dialog/0/field/x", f"picker in dialog -> {pid}")
        page.evaluate("__d.hide()")

        # Cached meta node
        res = send(page, {"type": "inspect", "id": "meta/User"}, "inspect")
        check(res["type"] == "inspect" and not res.get("missing"), "meta/User from the cache")

        check_navigation(page)
        check_timeline(page)
        browser.close()
    print("\nFAILURES:" if failures else "\nAll OK", failures or "")
    sys.exit(1 if failures else 0)


main()
