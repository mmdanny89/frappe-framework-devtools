"""Tests the Frappe Framework DevTools agent on a real v16 Desk, without Firefox.

Injects the agent scripts into the page and simulates the bridge: it sends commands
with postMessage and collects the answers. Read-only. It does not save documents.

Environment variables:
  FRAPPE_URL       site URL (default http://mysite.local:8000)
  FRAPPE_HOST_MAP  Chromium rule to resolve the host (default "MAP mysite.local 127.0.0.1")
  FRAPPE_USER      user (default Administrator)
  FRAPPE_PWD       password (or FRAPPE_SID)
  FRAPPE_SID       an existing session id, instead of the password
                   (for example from `bench --site <site> browse --user Administrator`)
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


def check_child_tables(page):
    """Cells of a table row (sent only while the row is open), grid state, row state and the picker."""
    goto(page, ["Form", "User", "Administrator"])
    page.wait_for_function("cur_frm?.doctype === 'User'")
    table, row_name = page.evaluate("""() => {
        const tables = cur_frm.layout.fields_list.filter(c => c.grid?.grid_rows?.length);
        const c = tables.find(c => c.grid.display_status === 'Write') || tables[0];
        return [c.df.fieldname, c.grid.grid_rows[0].doc.name];
    }""")
    row_id = f"form/row/{table}/{row_name}"
    tree = send(page, {"type": "tree"}, "tree")["tree"]
    row = next(n for n in walk(tree) if n["id"] == row_id)
    check(row.get("lazy") and not row.get("children"), f"child tables: a closed row sends no cells ({row_id})")

    page.evaluate("window.__msgs = []")
    page.evaluate("(id) => postMessage({source: 'frappe-devtools-bridge', json: JSON.stringify({type: 'expand', id, open: true})}, location.origin)", row_id)
    page.wait_for_function("(id) => __msgs.some(m => m.type === 'tree-changed' && JSON.stringify(m.tree).includes(id + '/field/'))", arg=row_id, timeout=4000)
    tree = [m for m in page.evaluate("window.__msgs") if m["type"] == "tree-changed"][-1]["tree"]
    row = next(n for n in walk(tree) if n["id"] == row_id)
    cells = row.get("children") or []
    columns = page.evaluate(f"cur_frm.fields_dict[{json.dumps(table)}].grid.visible_columns.map(([df]) => df.fieldname)")
    in_grid = [c["id"].rsplit("/", 1)[1] for c in cells if "in-grid" in c["flags"]]
    check(len(cells) > 0 and in_grid == columns, f"child tables: open row sends its cells ({len(cells)}), grid columns flagged {in_grid}")
    inspect_all(page, [row], "Open row")

    cell = f"{row_id}/field/{columns[0]}"
    res = send(page, {"type": "inspect", "id": cell}, "inspect")
    value = page.evaluate(f"cur_frm.doc[{json.dumps(table)}][0][{json.dumps(columns[0])}]")
    titles = [x["title"] for x in res["sections"]]
    check(res["sections"][0]["value"] == value and "Cell" in titles, f"cell: value {value!r} and sections {titles}")
    check(page.evaluate("window.$row?.doc?.name") == row_name and page.evaluate("Boolean(window.$grid?.grid_rows)"), "cell: $row and $grid in the console")

    res = send(page, {"type": "inspect", "id": f"form/field/{table}"}, "inspect")
    grid = next(x for x in res["sections"] if x["title"] == "Grid")["value"]
    cols = next(x for x in res["sections"] if x["title"].startswith("Grid columns"))["table"]
    rows = page.evaluate(f"cur_frm.doc[{json.dumps(table)}].length")
    check(grid["rows"] == rows and grid["child_doctype"] and [c["fieldname"] for c in cols] == columns, f"grid state: {grid['child_doctype']}, {grid['rows']} rows, {grid['display_status']}, columns from {grid['columns_from']}")
    res = send(page, {"type": "inspect", "id": row_id}, "inspect")
    state = next(x for x in res["sections"] if x["title"] == "Row state")["value"]
    check(state["drawn"] and state["page"] == 1 and not state["row_form_open"], f"row state: {state}")

    # Picker on a grid cell, then on a field of the open row form.
    pid = page.evaluate(f"FrappeDevtools.agent.picker.idFromElement(cur_frm.fields_dict[{json.dumps(table)}].grid.grid_rows[0].columns[{json.dumps(columns[0])}][0])")
    check(pid == cell, f"picker on a grid cell -> {pid}")
    page.evaluate(f"void cur_frm.fields_dict[{json.dumps(table)}].grid.grid_rows[0].toggle_view(true)")
    page.wait_for_timeout(800)
    res = send(page, {"type": "inspect", "id": row_id}, "inspect")
    state = next(x for x in res["sections"] if x["title"] == "Row state")["value"]
    check(state["row_form_open"], "row state: the row form is open")
    res = send(page, {"type": "inspect", "id": cell}, "inspect")
    cell_state = next(x for x in res["sections"] if x["title"] == "Cell")["value"]
    check(cell_state["edited_in"] == "row form", f"cell in the open row form: {cell_state}")
    pid = page.evaluate(f"""FrappeDevtools.agent.picker.idFromElement(
        cur_frm.fields_dict[{json.dumps(table)}].grid.grid_rows[0].grid_form.fields_dict[{json.dumps(columns[0])}].$wrapper[0])""")
    check(pid == cell, f"picker on the row form field -> {pid}")
    tree = send(page, {"type": "tree"}, "tree")["tree"]
    check("editing" in next(n for n in walk(tree) if n["id"] == row_id)["flags"], "row flagged as editing")
    page.evaluate(f"void cur_frm.fields_dict[{json.dumps(table)}].grid.grid_rows[0].toggle_view(false)")

    page.evaluate("(id) => postMessage({source: 'frappe-devtools-bridge', json: JSON.stringify({type: 'expand', id, open: false})}, location.origin)", row_id)
    page.wait_for_timeout(300)
    tree = send(page, {"type": "tree"}, "tree")["tree"]
    check(not next(n for n in walk(tree) if n["id"] == row_id).get("children"), "child tables: a closed row drops its cells")


def check_form_tools(page):
    """Show hidden fields, mark fields and the DocType shortcuts. Client side only: nothing is saved."""
    goto(page, ["Form", "User", "Administrator"])
    page.wait_for_function("cur_frm?.doctype === 'User'")
    hidden = page.evaluate("""() => {
        const c = cur_frm.layout.fields_list.find(c => c.df.hidden && !c.df.permlevel && !c.df.get_status && c.$wrapper?.hasClass('hide-control'));
        return c && c.df.fieldname;
    }""")
    check(bool(hidden), f"form tools: User has a hidden field to test ({hidden})")
    page.evaluate("void (window.__frms = [cur_frm])")
    is_hidden = f"cur_frm.fields_dict[{json.dumps(hidden)}].$wrapper.hasClass('hide-control')"

    res = send(page, {"type": "form-tool", "tool": "reveal", "on": True}, "form-tools")
    check(res.get("reveal") is True and res.get("mark") is False, f"reveal on: agent state {res}")
    page.wait_for_timeout(500)
    check(not page.evaluate(is_hidden), f"reveal: {hidden} is on screen")
    check(page.evaluate(f"cur_frm.fields_dict[{json.dumps(hidden)}].df.hidden") == 1, "reveal: df.hidden keeps its real value")
    sections = page.evaluate("cur_frm.layout.sections.filter(s => s.df?.hidden).map(s => s.wrapper.hasClass('hide-control'))")
    check(not any(sections), f"reveal: hidden sections are on screen ({len(sections)})")
    tree = send(page, {"type": "tree"}, "tree")["tree"]
    node = next(n for n in walk(tree) if n["id"] == f"form/field/{hidden}")
    check("hidden" in node["flags"], f"reveal: the tree still flags {hidden} as hidden {node['flags']}")
    why = send(page, {"type": "inspect", "id": f"form/field/{hidden}"}, "inspect")["sections"][1]["value"]["reasons"]
    check(any("Show hidden fields" in r for r in why), f"reveal: the inspector says why it is on screen {why}")

    # Global: it follows the user to the next form.
    goto(page, ["Form", "ToDo", "new"])
    page.wait_for_function("cur_frm?.doctype === 'ToDo'")
    page.wait_for_timeout(1500)
    page.evaluate("window.__frms.push(cur_frm)")
    todo_hidden = page.evaluate("cur_frm.layout.fields_list.filter(c => c.df.hidden && !c.df.permlevel && !c.df.get_status).map(c => c.$wrapper.hasClass('hide-control'))")
    check(todo_hidden and not any(todo_hidden), f"reveal: follows to the next form (ToDo, {len(todo_hidden)} hidden fields)")

    send(page, {"type": "form-tool", "tool": "reveal", "on": False}, "form-tools")
    page.wait_for_timeout(300)
    todo_hidden = page.evaluate("cur_frm.layout.fields_list.filter(c => c.df.hidden && !c.df.permlevel && !c.df.get_status).map(c => c.$wrapper.hasClass('hide-control'))")
    check(all(todo_hidden), "reveal off: ToDo hides its fields again")
    wrapped = page.evaluate("""__frms.flatMap(f => [...f.layout.fields_list, ...f.layout.sections, ...f.layout.tabs])
        .filter(c => Object.hasOwn(c, 'get_status') || Object.hasOwn(c, 'refresh')).length""")
    check(wrapped == 0, f"reveal off: no wrapped get_status left ({wrapped})")

    # Marks: a fake custom field (only in the browser) gets a solid outline.
    page.evaluate("cur_frm.fields_dict.description.df.is_custom_field = 1")
    send(page, {"type": "form-tool", "tool": "mark", "on": True}, "form-tools")
    page.wait_for_timeout(300)
    outline = page.evaluate("getComputedStyle(cur_frm.fields_dict.description.$wrapper[0]).outlineStyle")
    check(outline == "solid", f"mark: custom field outlined ({outline})")
    tree = send(page, {"type": "tree"}, "tree")["tree"]
    node = next(n for n in walk(tree) if n["id"] == "form/field/description")
    check("custom" in node["flags"], f"tree flags custom fields {node['flags']}")
    page.screenshot(path=str(OUT / "frappe-devtools-marks.png"))
    page.evaluate("postMessage({source: 'frappe-devtools-bridge', json: JSON.stringify({type: 'panel-closed'})}, location.origin)")
    page.wait_for_timeout(200)
    check(not page.evaluate("document.querySelector('style[data-frappe-devtools]')"), "panel closed: marks removed")
    page.evaluate("cur_frm.fields_dict.description.df.is_custom_field = 0")

    # Shortcuts: a Link field opens the DocType it points to. Core DocTypes (User) cannot be customized.
    link = page.evaluate("cur_frm.meta.fields.find(f => f.fieldtype === 'Link' && f.options === 'User').fieldname")
    res = send(page, {"type": "inspect", "id": f"form/field/{link}"}, "inspect")
    names = [a["name"] for a in res.get("actions", [])]
    check(names == ["edit-doctype"], f"shortcuts on a Link to User: {names}")
    res = send(page, {"type": "inspect", "id": "form"}, "inspect")
    names = [a["name"] for a in res.get("actions", [])]
    check(names == ["edit-doctype", "customize-form"], f"shortcuts on the ToDo form: {names}")
    res = send(page, {"type": "action", "id": f"form/field/{link}", "action": "customize-form"}, "action-done")
    check(res["result"] is None, "shortcuts: an action that is not offered does not run")
    send(page, {"type": "action", "id": "form", "action": "customize-form"}, "action-done")
    page.wait_for_timeout(1500)
    route = page.evaluate("[frappe.get_route(), cur_frm?.doc?.doc_type]")
    check(route[0][:2] == ["Form", "Customize Form"] and route[1] == "ToDo", f"Customize Form opens for ToDo: {route}")
    goto(page, ["Form", "ToDo", "new"])
    # Frappe can load the DocType editor as a new page, so check the URL, not the route.
    send(page, {"type": "action", "id": f"form/field/{link}", "action": "edit-doctype"}, "action-done")
    page.wait_for_timeout(3000)
    check("/doctype/User" in page.url, f"Edit DocType opens User: {page.url}")


def login(page):
    status = page.evaluate("""([usr, pwd]) => fetch('/api/method/login', {method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({usr, pwd})}).then(r => r.status)""", [os.environ.get("FRAPPE_USER", "Administrator"), os.environ["FRAPPE_PWD"]])
    print("login:", status)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH"), args=[f"--host-resolver-rules={HOST_MAP}"])
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.on("pageerror", lambda e: print("  pageerror:", e))
        page.goto(f"{BASE}/login")
        if os.environ.get("FRAPPE_SID"):
            page.context.add_cookies([{"name": "sid", "value": os.environ["FRAPPE_SID"], "url": BASE}])
        else:
            login(page)
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
        check_child_tables(page)
        check_form_tools(page)
        browser.close()
    print("\nFAILURES:" if failures else "\nAll OK", failures or "")
    sys.exit(1 if failures else 0)


main()
