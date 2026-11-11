"""Security and transparency tests that need no Frappe server.

Playwright serves a fake page on a development host (http://devtest.local) and fakes /api.
The tests check that:
  - the fetch wrapper behaves exactly like the native fetch (results, errors, abort, body),
  - the frappe-ui config object keeps setConfig/getConfig semantics,
  - forged or malformed page messages cannot break or fool the bridge,
  - page data cannot inject HTML or run script in the panel or the popup,
  - console variables never overwrite globals that the page defined itself,
  - the element picker and the highlight stop when the panel closes,
  - the Reload action runs a resource that can change data only after a confirmation,
  - the agent refuses sites without developer_mode, older than Frappe 16, or that it cannot check.

Environment variables:
  CHROMIUM_PATH    Chromium executable (optional)
"""
import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

EXT = Path(__file__).resolve().parent.parent
BASE = "http://devtest.local"
# The same scripts, in the same order, as the manifest loads at document_idle.
AGENT_FILES = [Path(p).stem for p in json.loads((EXT / "manifest.json").read_text())["content_scripts"][2]["js"]]
XSS = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=1</script>'

FAKE_PAGE = """<!doctype html><html><body><div id="app"></div>
<iframe id="frame" srcdoc="<p>child</p>"></iframe>
<script>window.$app = "page-owned global";</script></body></html>"""

failures = []


def check(cond, label):
    print(("OK   " if cond else "FAIL ") + label)
    if not cond:
        failures.append(label)


def fake_api(route):
    url = route.request.url
    if "/api/method/fail" in url:
        body = {"exc_type": "ValidationError", "exc": json.dumps(["Traceback: boom"]), "_server_messages": json.dumps([json.dumps({"message": XSS})])}
        return route.fulfill(status=417, content_type="application/json", body=json.dumps(body))
    if "/api/method/slow" in url:
        import time
        time.sleep(1)
    return route.fulfill(status=200, content_type="application/json", body=json.dumps({"message": {"ok": True, "html": XSS}}))


def open_fake_page(browser):
    page = browser.new_page()
    page.route(f"{BASE}/api/**", fake_api)
    page.route(f"{BASE}/", lambda r: r.fulfill(status=200, content_type="text/html", body=FAKE_PAGE))
    page.add_init_script(path=str(EXT / "agent" / "early.js"))
    page.goto(f"{BASE}/")
    return page


def test_fetch_transparency(page):
    result = page.evaluate("""async () => {
        const out = {};
        let r = await fetch('/api/method/ping', {method: 'POST', body: JSON.stringify({a: 1})});
        out.json = await r.json();
        out.ok = r.ok;
        r = await fetch(new Request('/api/method/ping'));
        out.request = (await r.json()).message.ok;
        r = await fetch(new URL('/api/method/ping', location.href));
        out.urlObject = (await r.json()).message.ok;
        r = await fetch('/api/method/ping');
        out.text = (await r.text()).length > 0;
        try { await fetch('http://[invalid'); out.invalid = 'no error'; } catch (e) { out.invalid = e.constructor.name; }
        const c = new AbortController();
        const p = fetch('/api/method/slow', {signal: c.signal});
        c.abort();
        try { await p; out.abort = 'not aborted'; } catch (e) { out.abort = e.name; }
        out.fetchName = fetch.name;
        return out;
    }""")
    check(result["json"]["message"]["ok"] is True and result["ok"], "fetch: the app still reads the JSON body")
    check(result["request"] and result["urlObject"], "fetch: Request and URL inputs work")
    check(result["text"], "fetch: the app can read the body as text after the wrapper cloned it")
    check(result["invalid"] == "TypeError", f"fetch: an invalid URL still raises TypeError ({result['invalid']})")
    check(result["abort"] == "AbortError", f"fetch: abort still works ({result['abort']})")
    calls = page.evaluate("FrappeDevtools.early.calls.map(c => [c.name, c.status])")
    check(len(calls) >= 4, f"fetch: the wrapper recorded the /api calls ({len(calls)})")


def test_config_proxy(page):
    result = page.evaluate("""async () => {
        // The same code as frappe-ui moduleSingleton() + setConfig/getConfig.
        const symbol = Symbol.for('frappe-ui.config');
        if (!(symbol in globalThis)) globalThis[symbol] = {};
        const config = globalThis[symbol];
        const getConfig = (k) => config[k] ?? null;
        const before = getConfig('resourceFetcher');
        config.systemTimezone = 'Europe/Madrid';
        const fetcher = async (opts) => ({ echoed: opts.params });
        config.resourceFetcher = fetcher;
        const data = await getConfig('resourceFetcher')({ url: 'x.y', params: { a: 1 } });
        let thrown = null;
        config.resourceFetcher = async () => { throw new Error('server said no'); };
        try { await getConfig('resourceFetcher')({ url: 'x.fail' }); } catch (e) { thrown = e.message; }
        return { before, tz: getConfig('systemTimezone'), missing: getConfig('nope'), data, thrown,
                 keys: Object.keys(config), entries: FrappeDevtools.early.resources.size };
    }""")
    check(result["before"] is None and result["missing"] is None, "config: unset keys read as null")
    check(result["tz"] == "Europe/Madrid", "config: other keys are stored unchanged")
    check(result["data"] == {"echoed": {"a": 1}}, "config: the wrapped resourceFetcher returns the same data")
    check(result["thrown"] == "server said no", "config: the wrapped resourceFetcher passes errors through")
    check(result["entries"] == 2, f"config: resource requests recorded ({result['entries']})")


def test_bridge_messages(browser):
    page = browser.new_page()
    page.route(f"{BASE}/", lambda r: r.fulfill(status=200, content_type="text/html", body=FAKE_PAGE))
    page.add_init_script("""
        window.__toBackground = [];
        window.__errors = 0;
        addEventListener('error', () => window.__errors++);
        window.browser = { runtime: { connect: () => ({
            onMessage: { addListener(fn) { window.__toAgent = fn; } },
            onDisconnect: { addListener() {} },
            postMessage: (m) => window.__toBackground.push(m),
        }) } };
    """)
    page.add_init_script(path=str(EXT / "content" / "bridge.js"))
    page.goto(f"{BASE}/")
    page.evaluate("""() => {
        postMessage({source: 'frappe-devtools-agent', json: '{not json'}, '*');
        postMessage({source: 'frappe-devtools-agent', json: 42}, '*');
        postMessage({source: 'frappe-devtools-agent'}, '*');
        postMessage('plain string', '*');
        document.getElementById('frame').contentWindow.eval(
            "parent.postMessage({source: 'frappe-devtools-agent', json: JSON.stringify({type: 'status', state: 'active', site: 'from-iframe'})}, '*')");
        postMessage({source: 'frappe-devtools-agent', json: JSON.stringify({type: 'tree', tree: []})}, '*');
    }""")
    page.wait_for_timeout(300)
    sent = page.evaluate("__toBackground")
    errors = page.evaluate("__errors")
    check(errors == 0, f"bridge: malformed messages do not throw ({errors} errors)")
    check(not any(m.get("site") == "from-iframe" for m in sent if isinstance(m, dict)), "bridge: messages from an iframe are ignored")
    check(any(m.get("type") == "tree" for m in sent if isinstance(m, dict)), "bridge: a valid agent message still goes through")
    page.close()


def panel_stub(theme="light", popup="{}"):
    return f"""
        window.__sent = []; window.__listeners = [];
        const port = {{ onMessage: {{ addListener: (fn) => __listeners.push(fn) }}, onDisconnect: {{ addListener() {{}} }},
                       postMessage: (m) => __sent.push(m) }};
        window.browser = {{
          devtools: {{ inspectedWindow: {{ tabId: 1 }}, panels: {{ themeName: "{theme}", onThemeChanged: {{ addListener() {{}} }} }},
                      network: {{ onRequestFinished: {{ addListener(fn) {{ window.__har = fn; }} }} }} }},
          runtime: {{ connect: () => port, sendMessage: async () => ({popup}) }},
          tabs: {{ query: async () => [{{ id: 1 }}] }},
        }};
        window.__emit = (m) => __listeners.forEach((fn) => fn(m));
    """


def test_panel_injection(browser):
    page = browser.new_page()
    page.add_init_script(panel_stub())
    page.goto(f"file://{EXT}/panel/panel.html")
    node = {"id": "form", "label": XSS, "kind": XSS, "detail": XSS, "flags": [XSS], "children": [
        {"id": "form/field/x", "label": XSS, "kind": "field", "detail": XSS, "flags": ["hidden"]}]}
    page.evaluate("(m) => __emit(m)", {"type": "status", "state": "active", "reason": XSS})
    page.evaluate("(m) => __emit(m)", {"type": "tree", "tree": [node]})
    page.evaluate("(m) => __emit(m)", {"type": "picked", "id": "form/field/x"})
    page.evaluate("(m) => __emit(m)", {"type": "inspect", "id": "form/field/x", "consoleVars": [XSS],
        "actions": [{"name": "reload", "label": XSS}],
        "sections": [{"title": XSS, "value": {XSS: XSS, "list": [XSS]}, "open": True},
                     {"title": XSS, "table": [{XSS: XSS}], "open": True},
                     {"title": XSS, "text": XSS, "open": True}]})
    page.evaluate("(m) => __emit(m)", {"type": "timeline", "events": [{"id": 1, "t": 0, "cat": "msg", "title": XSS, "detail": XSS,
        "level": XSS, "data": {"traceback": XSS, "x": XSS}, "stack": XSS}]})
    page.evaluate("(m) => __emit(m)", {"type": "info", "mode": "ui", "summary": {"site": XSS, "user": XSS}, "sections": [{"title": XSS, "value": XSS}]})
    page.evaluate("(m) => __emit(m)", {"type": "error", "message": XSS, "stack": XSS, "command": XSS})
    page.click("button[data-tab=timeline]")
    page.click("#timeline-body tr")
    page.click("button[data-tab=info]")
    page.evaluate("""() => window.__har({ request: { url: 'http://devtest.local/api/method/' + encodeURIComponent('<img src=x onerror=window.__pwn=1>'),
        method: 'POST', postData: { text: 'a=' + encodeURIComponent('<img src=x onerror=window.__pwn=1>') } },
        response: { status: 417 }, time: 1, getContent: async () => [JSON.stringify({ exc: JSON.stringify(['<img src=x onerror=window.__pwn=1>']) })] })""")
    page.wait_for_timeout(300)
    page.click("button[data-tab=calls]")
    page.click("#calls-body tr")
    page.wait_for_timeout(300)
    injected = page.evaluate("document.querySelectorAll('img:not(.logo), script:not([src])').length")
    check(not page.evaluate("window.__pwn"), "panel: page data never runs script")
    check(injected == 0, f"panel: page data never becomes HTML elements ({injected})")
    page.close()

    popup = browser.new_page()
    popup.add_init_script(panel_stub(popup=json.dumps({"status": {"state": "active", "site": XSS, "user": XSS, "version": XSS}, "hasAgent": True})))
    popup.goto(f"file://{EXT}/popup/popup.html")
    popup.wait_for_timeout(300)
    injected = popup.evaluate("document.querySelectorAll('img[src=x], script:not([src])').length")
    check(not popup.evaluate("window.__pwn") and injected == 0, "popup: page data never becomes HTML or runs script")
    popup.close()


def load_agent(page):
    page.add_init_script("""window.__msgs = []; addEventListener('message', e => {
        if (e.data?.source === 'frappe-devtools-agent') __msgs.push(JSON.parse(e.data.json)); });""")


def send(page, msg):
    page.evaluate("(m) => postMessage({source: 'frappe-devtools-bridge', json: JSON.stringify(m)}, location.origin)", msg)
    page.wait_for_timeout(150)


def desk_route(developer_mode=1, version="16.52.0", guest=False):
    def handle(route):
        if guest:
            return route.fulfill(status=302, headers={"Location": "/login?redirect-to=/desk"}, body="")
        boot = {"sitename": "devtest.local", "developer_mode": developer_mode, "versions": {"frappe": version, "erpnext": "16.0.0"}}
        html = ("<script>frappe.boot = " + json.dumps(boot, separators=(",", ":")) + ";\n"
                'frappe.csrf_token = "desk-made-token";</script>')
        return route.fulfill(status=200, content_type="text/html", body=html)
    return handle


def fake_ui_page(browser, page_token="x", **desk):
    """A tiny Vue-like app object is enough for the agent's frappe-ui mode."""
    page = browser.new_page()
    page.route(f"{BASE}/api/**", fake_api)
    page.route(f"{BASE}/desk", desk_route(**desk))
    page.route(f"{BASE}/", lambda r: r.fulfill(status=200, content_type="text/html", body=FAKE_PAGE))
    page.add_init_script(path=str(EXT / "agent" / "early.js"))
    load_agent(page)
    page.goto(f"{BASE}/")
    page.evaluate("""(PAGE_TOKEN) => {
        const res = (extra) => Object.assign({ data: null, loading: false, fetched: true, error: null, auto: false,
            reloads: 0, reload() { this.reloads++; } }, extra);
        window.__res = {
            list: res({ url: 'frappe.client.get_list', auto: true }),
            mutation: res({ url: 'app.api.delete_everything' }),
            doc: Object.assign(res({ doctype: 'ToDo', name: 'X' }), { doc: {}, setValue() {}, get: {} }),
        };
        const store = { $id: 'store', ...__res };
        const app = { version: '3.5.0', _instance: null, _context: { provides: {} },
            config: { globalProperties: { $pinia: { _s: new Map([['store', new Proxy(store, {})]]) } } } };
        document.getElementById('app').setAttribute('data-v-app', '');
        document.getElementById('app').__vue_app__ = app;
        if (PAGE_TOKEN !== null) window.csrf_token = PAGE_TOKEN;
        else window.frappe = { boot: {} }; // still recognizable as a Frappe app without a token
    }""", page_token)
    for name in AGENT_FILES:
        page.add_script_tag(path=str(EXT / "agent" / f"{name}.js"))
    page.wait_for_function("['active', 'inactive'].includes(FrappeDevtools.agent.state)", timeout=8000)
    return page


def test_site_checks(browser):
    cases = [
        ({"developer_mode": 0}, "developer_mode is off"),
        ({"version": "15.80.0"}, "needs Frappe 16 or later"),
        ({"guest": True}, "Log in as a Desk user"),
    ]
    for desk, expected in cases:
        page = fake_ui_page(browser, **desk)
        state, reason, recording = page.evaluate("[FrappeDevtools.agent.state, FrappeDevtools.agent.reason, FrappeDevtools.early.recording]")
        check(state == "inactive" and expected in reason, f"site check {desk}: inactive ({reason})")
        check(recording is False, f"site check {desk}: the early hooks stop recording")
        page.close()


def test_csrf_token(browser):
    page = fake_ui_page(browser, page_token=None)
    check(page.evaluate("window.csrf_token") == "desk-made-token", "csrf: a page without a token gets the one /desk created")
    page.close()
    page = fake_ui_page(browser, page_token="{{ csrf_token }}")
    check(page.evaluate("window.csrf_token") == "desk-made-token", "csrf: a page with an unrendered placeholder gets it too")
    page.close()
    page = fake_ui_page(browser, page_token="page-own-token")
    check(page.evaluate("window.csrf_token") == "page-own-token", "csrf: a page that has its own token keeps it")
    page.close()


def test_agent_on_fake_ui_app(browser):
    page = fake_ui_page(browser)
    check(page.evaluate("FrappeDevtools.agent.state") == "active", "site check: active with developer_mode on Frappe 16")
    send(page, {"type": "hello"})

    for key in ("list", "doc", "mutation"):
        send(page, {"type": "inspect", "id": f"ui/store/store/{key}"})
    inspected = {m["id"].split("/")[-1]: m for m in page.evaluate("__msgs") if m["type"] == "inspect"}
    check(bool(inspected["list"].get("actions")), "reload: offered for an auto-loaded resource")
    check(bool(inspected["doc"].get("actions")), "reload: offered for a document resource")
    mutation_action = (inspected["mutation"].get("actions") or [{}])[0]
    check(bool(mutation_action.get("confirm")), "reload: a resource that can change data asks for confirmation")
    send(page, {"type": "action", "id": "ui/store/store/mutation", "action": "reload"})
    check(page.evaluate("__res.mutation.reloads") == 0, "reload: without confirmation it does not run")
    send(page, {"type": "action", "id": "ui/store/store/mutation", "action": "reload", "confirmed": True})
    check(page.evaluate("__res.mutation.reloads") == 1, "reload: with confirmation it runs once")
    send(page, {"type": "action", "id": "ui/store/store/list", "action": "reload"})
    check(page.evaluate("__res.list.reloads") == 1, "reload: a read resource runs without confirmation")

    check(page.evaluate("window.$app") == "page-owned global", "console: a global the page owns ($app) is not overwritten")
    vars_list = inspected["list"].get("consoleVars", [])
    check("$app" not in vars_list and "$resource" in vars_list, f"console: the inspector lists only the variables it set ({vars_list})")

    send(page, {"type": "pick", "on": True})
    send(page, {"type": "highlight", "id": "ui/store/store/list"})
    send(page, {"type": "panel-closed"})
    clicked = page.evaluate("""() => { let hit = false; document.body.addEventListener('click', () => hit = true);
        document.body.click(); return hit; }""")
    check(clicked, "picker: stops capturing page clicks when the panel closes")
    page.close()


def test_redaction(browser):
    page = open_fake_page(browser)
    page.evaluate("""() => fetch('/api/method/login', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({usr: 'Administrator', pwd: 'secret-value', api_key: 'k', other: 'kept'})})""")
    page.wait_for_timeout(300)
    args = page.evaluate("FrappeDevtools.early.calls.find(c => c.name === 'login')?.args")
    check(args and args["pwd"] == "***" and args["api_key"] == "***" and args["other"] == "kept", f"redaction: passwords and keys are hidden ({args})")
    page.close()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH"),
                                    args=["--host-resolver-rules=MAP devtest.local 127.0.0.1", "--allow-file-access-from-files"])
        page = open_fake_page(browser)
        test_fetch_transparency(page)
        test_config_proxy(page)
        page.close()
        test_bridge_messages(browser)
        test_panel_injection(browser)
        test_site_checks(browser)
        test_csrf_token(browser)
        test_agent_on_fake_ui_app(browser)
        test_redaction(browser)
        browser.close()
    print("\nFAILURES:" if failures else "\nAll OK", failures or "")
    sys.exit(1 if failures else 0)


main()
