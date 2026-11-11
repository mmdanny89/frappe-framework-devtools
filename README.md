# Frappe Framework DevTools

> **Only for development instances.** The extension works only on sites that run **Frappe 16 or later** with **`developer_mode` on**, opened from a development host. On any other site it stays inactive and changes nothing. Do not use it to inspect production sites.

A Firefox extension that adds a **Frappe** tab to DevTools. It does for Frappe what Vue DevTools does for Vue. It shows a tree of what is on screen, inspects its state, selects elements on the page, records a timeline of events and puts the objects in the console.

It works in two modes:

- **Desk mode:** Frappe Desk (`/desk`). Desk does not use Vue, so Vue DevTools cannot see forms, lists or dialogs. This extension can.
- **frappe-ui mode:** apps built with [frappe-ui](https://github.com/frappe/frappe-ui), such as Helpdesk, CRM, Gameplan, Insights, HRMS, Builder or your own. Vue DevTools already shows their components, Pinia stores and router. This extension adds what is specific to Frappe: the frappe-ui **resources**, the calls to the Frappe API and the server messages.

## Requirements

- Firefox 128 or later. The extension uses content scripts in the `MAIN` world.
- A development instance of Frappe. The extension checks all three conditions and stays inactive if one fails:
  1. **Frappe 16 or later.** Versions 14 and 15 are not supported.
  2. **`developer_mode` is on**, in `site_config.json` or in `common_site_config.json`.
  3. **A development host:** `localhost`, `127.0.0.1`, `*.localhost`, `*.local` or `*.test`. On other hosts Firefox does not even load the extension scripts.

How the extension reads `developer_mode` and the Frappe version:

| Mode | Source |
|---|---|
| Desk | `frappe.boot` of the page. |
| frappe-ui | frappe-ui pages do not expose them, and no Frappe API returns `developer_mode`. So the agent opens `/desk` in the background, with the same session, and reads `frappe.boot` there. A Guest cannot open `/desk`, so **in frappe-ui apps you must be logged in as a Desk user**. |

If a condition fails, or the extension cannot check it, the panel still shows but stays inactive and tells you why. The page hooks stop recording at that moment.

## Installation

To try the extension without signing it:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select the `manifest.json` file in this folder.
4. Reload the Frappe tabs that were already open.

Firefox removes temporary add-ons when it closes. For development, use `web-ext`. It reloads the extension when you save a file:

```sh
npx web-ext run --source-dir . --start-url http://mysite.local:8000/desk
```

The first time, Firefox can ask for permission to access the development hosts. If it does not ask, grant the permission in `about:addons` → Frappe Framework DevTools → Permissions.

## Usage

### Toolbar button

The extension puts the Frappe "F" on the toolbar, like Vue DevTools does with its logo. The icon is the original Frappe favicon (`frappe/public/images/frappe-favicon.svg`), unchanged.

- **Enabled button:** the tab has Frappe Desk active. Click it to see the site, the user and the Frappe version.
- **Disabled button** (Firefox dims it): the tab has no Frappe, the host is not a development host, `developer_mode` is off, the site runs a Frappe version older than 16, or (in frappe-ui apps) you are not logged in as a Desk user. The DevTools panel shows the reason.

If you do not see the icon, find it in the extensions menu (the puzzle piece button) and pin it to the toolbar.

### DevTools panel

Open DevTools (F12) on a Desk page (`/desk/...`) and select the **Frappe** tab.

The panel uses the Lucide icons that Frappe Desk and frappe-ui use, copied unchanged from Frappe's own sprite. Tree nodes show an icon for their kind, and fields show an icon for their `fieldtype` (text, link, select, date, table, currency…). Every inspector section has a **Copy** button that copies its data as JSON, or as text for tracebacks and stacks. While nothing is selected, the right side of the Tree, Timeline and Calls tabs shows the Frappe "F" with a slow breathing animation and a hint of what to select. The animation stops when the system asks for reduced motion.

### Tree tab

The left side shows the tree of the current view:

| Node | Content |
|---|---|
| Route | The current URL, `frappe.get_route()`, `frappe.route_options` and the last 15 routes. |
| Form | The open form, with its tabs, sections and fields. Child tables show their rows. |
| Meta (inside Form) | The meta of the form's DocType. |
| List | The list view: filters, sort order, queried fields and loaded rows. |
| Dialog | Each open dialog, with its fields and values. |
| Cached meta | Every DocType whose meta is already on the client (`locals.DocType`). |

The labels on each node show its state: `hidden`, `read only`, `mandatory`, `new`, `not saved`, `submitted`, `cancelled`, `child table`, `single` and `custom`.

The right side is the inspector for the selected node. For a field, it shows:

- **Value:** the current value of the control.
- **Why does it look like this?:** the `disp_status` that Frappe computes (`Write`, `Read` or `None`) and the probable reasons. For example, `depends_on`, `read_only_depends_on`, `permlevel` or a submitted document without `allow_on_submit`.
- **DocField (df):** the full docfield, including the properties that code changes, such as `hidden_due_to_dependency`.
- **Control:** the control object, two levels deep.

For a meta, the fields show in a table with a filter. The properties and the permissions are in separate sections.

Other tree actions:

- Move the mouse over a node to highlight its element on the page.
- Type in the filter to search by label or by fieldname.
- Click the crosshair button to select a field on the page. The panel selects the node of the field, the table row or the dialog. Press Esc to cancel.

The tree and the inspector update on their own when the route changes, the form refreshes, a value changes, or a dialog opens or closes.

### frappe-ui mode

On a frappe-ui app, the Tree tab shows:

| Node | Content |
|---|---|
| Route | The vue-router route: path, name, params, query, meta, matched routes and the list of all routes. |
| Live resources | The resource objects that the app holds, grouped by owner (component, Pinia store or app global). |
| Resource requests | Every request that a `createResource`, `createListResource` or `createDocumentResource` made: URL, DocType, number of calls, last params, last data, last error and the JS stack. |

The extension recognizes every kind of frappe-ui resource: `createResource`, `createListResource`, `createDocumentResource`, `useCall`, `useList` and `useDoc`. It also recognizes an app's own document resource that has `doctype`, `doc`, `loading` and `load()`, such as `useDocumentResource` in Insights 3. It shows it as `app resource (load)`. A live resource shows its state (`loading`, `fetched`, `error`), its data and its params.

`reload()` sends the last request again, with the same params. That is safe for a resource that only reads, and dangerous for one that writes (a payment, an insert, a delete). So:

- **Reload** shows for resources that only read: list and document resources, `useList`, `useDoc`, auto-loaded resources, `GET` requests and methods named `get…`, `search…`, `whoami` or `ping`.
- **Run again…** shows for every other resource. The first click only shows the URL and a warning. A second click within 5 seconds sends the request. The agent refuses to run such a resource without that confirmation.

frappe-ui keeps no list of resources, so the extension finds live resources where the app holds them:

| Where | Production build | Development build (Vite) |
|---|---|---|
| Component `<script setup>` | No. Vue does not expose it. | Yes |
| Options API `resources: {...}` | Yes | Yes |
| Pinia stores | Yes | Yes |
| `app.config.globalProperties` and `app.provide()` | Yes | Yes |

Resources that an app keeps in plain modules (for example `src/data/*.js`) are not reachable as live objects. Their requests still show under **Resource requests**.

The Timeline tab records route changes, every call to `/api` (also the calls the app made while it loaded), the server messages (`_server_messages`) and the socket.io events. The Info tab shows the site, the user, the Vue version, the Pinia stores, `window.frappe.boot` and the frappe-ui config.

In frappe-ui mode, the element picker selects the component that owns the resources. It works only in development builds, because Vue links DOM elements to components only there.

### Console variables

When you select a node, the agent creates these variables in the page, like `$vm0` in Vue DevTools:

| Variable | Content |
|---|---|
| `$frm` | The form (`cur_frm`). |
| `$doc` | The document, the child table row or the dialog `doc`. |
| `$df` | The docfield of the field. |
| `$control` | The control of the field. |
| `$meta` | The meta of the DocType. |
| `$list` | The list view. |
| `$dialog` | The dialog. |

In frappe-ui mode:

| Variable | Content |
|---|---|
| `$resource` | The selected live resource. Try `$resource.reload()` or `$resource.data`. |
| `$vm` | The component that owns the resource. |
| `$store` | The Pinia store that owns the resource. |
| `$router`, `$route` | The vue-router instance and the current route. |
| `$app` | The Vue app. |

The inspector tells you which variables have a value. Use them in the DevTools Console tab, for example `$frm.set_value("status", "Open")`.

### Timeline tab

Shows what happens in Desk, newest event first:

| Type | What it records |
|---|---|
| Route | Each route change, with the previous route. |
| Form | `load`, `refresh`, `rename` and `unload` of each form. |
| Field | Each value change made with `frappe.model.set_value` (also `frm.set_value` and what the user types): old value, new value and the child table row, if there is one. |
| Call | Each `frappe.call` (also `frappe.xcall` and `frappe.db.*`): method, arguments, duration, and the response or the error with its traceback. |
| Dialog | Each dialog that opens or closes. |
| Message | `frappe.msgprint`, `frappe.throw`, `frappe.show_alert` and the server messages. The level comes from the indicator color. |
| Realtime | Each event that arrives through socket.io. |

When you select an event, the detail shows its data and the **JS stack of who caused it**. This tells you which form script changed a field or made a call. If a call fails, the server traceback shows as plain text.

The agent records from the moment Desk becomes active, even while DevTools is closed. It keeps the last 1000 events, so when you open the panel you also see what happened before. You can filter by type and by text, pause the recording in the panel and clear the record.

### Info tab

Data from `frappe.boot`: site, user, language, time zone, `developer_mode`, app versions, roles, `sysdefaults` and the full `boot`.

### Calls tab

Lists the calls to the Frappe API: `/api/method`, `/api/resource` and the v2 API routes (`/api/v2/method`, `/api/v2/document`, `/api/v2/doctype`). For each call, it shows:

- The arguments from the query string and from the body. JSON values are decoded.
- The traceback as plain text, if there is an error. It comes from `exc` (v1) or from `errors[].exception` (v2).
- The decoded `msgprint` messages (`_server_messages`) and `errprint` messages (`_debug_messages`).
- The response (`message` or `data`) and the full response.

You can filter by text and show only errors. The list keeps the last 500 calls. It records calls only while the panel is open and only on development sites.

## Architecture

The structure is the same as in Vue DevTools. An agent lives in the page and talks to the panel through a bridge:

```
Page (MAIN world)          Content script         Background script      DevTools panel
agent/*.js  ── postMessage ──▶ content/bridge.js ── port ──▶ background.js ── port ──▶ panel/*.js
(hooks and serializer) ◀──────────────────── commands (inspect, pick, highlight…) ◀──┘
```

- The **early hooks** (`agent/early.js`) load at `document_start`, before any app script. They wrap `window.fetch` and create the frappe-ui config object first, so that they see the calls an app makes while it loads.
- The **agent** can read `frappe`, `cur_frm`, the Vue app and the other page objects. It detects the mode (Desk or frappe-ui), hooks the events and answers the commands.
- The **bridge** (`content/bridge.js`) passes messages between the page and the extension. The data crosses as JSON text, so Firefox Xray wrappers do not get in the way.
- The **background script** (`background.js`) connects each tab to its panel by `tabId`. It also reads the agent `status` messages to enable the toolbar button and to answer the popup. Firefox can unload it at any time. The bridge and the panel reconnect on their own, and the background script asks the agent for its state again.
- The **panel** (`panel/`) draws the views. All text from the page goes in with `textContent`, never as HTML.

The panel is always created, because Firefox cannot remove it later. The content scripts load only on the development hosts in the manifest. Also, the agent does nothing unless the site runs Frappe 16 or later with `developer_mode` on (see [Requirements](#requirements)).

### Security

The extension sends nothing outside the browser. It asks for no permissions, has no remote code and uses the default MV3 content security policy. The manifest declares `data_collection_permissions: none`.

| Risk | How the extension handles it |
|---|---|
| The page sends fake messages | The bridge and the agent accept only messages from the same window, not from iframes, and drop malformed ones. The background script takes the tab id from `port.sender.tab`, which the browser sets. So a page can only send fake data to the panel of its own tab. |
| Page data in the panel or popup | All page text goes in with `textContent` and `createElement`. There is no `innerHTML`, `eval` or URL built from page data. |
| The hooks change the app | The real `fetch`, `resourceFetcher` and Frappe functions are always called first, with the same arguments. Every recording step runs inside `try`. Response bodies are read only when they are JSON and smaller than 2 MB. |
| Passwords in the page buffers | Arguments named like `pwd`, `password`, `secret`, `token`, `api_key`, `otp`, `signature`, `card` or `cvv` are stored as `***`. |
| Repeating a write | See the Reload rules in [frappe-ui mode](#frappe-ui-mode). |
| Console variables | A name such as `$app` is written only if the page does not use it already. Names that do not apply are deleted. |
| The element picker blocks the page | It blocks pointer, touch and mouse events only while it picks. It stops on Esc, when the tab is hidden and when the last DevTools panel of the tab closes. |
| Memory | The buffers keep at most 200 calls, 300 resource requests and 1000 timeline events. |
| Unsupported sites | When the agent goes inactive, the early hooks stop recording and drop what they buffered. |
| The `/desk` check and CSRF | Opening `/desk` makes Frappe create a CSRF token in the session if it had none. From then on Frappe checks it on every POST. A page without a token (for example an app served by the Vite dev server) would then fail with `CSRFTokenError`. So if the page has no valid `window.csrf_token`, the agent gives it the token that `/desk` created. A page that has its own token keeps it. |

### Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest. Development hosts, content scripts, toolbar button and DevTools page. |
| `background.js` | Routes messages between a tab and its panel. Enables the toolbar button. |
| `content/bridge.js` | Bridge between the agent and the background script. |
| `agent/early.js` | Early hooks: `window.fetch` and the frappe-ui `resourceFetcher`. They stop when the agent goes inactive. |
| `agent/serializer.js` | Turns Frappe objects into plain data. Cuts cycles, DOM nodes, jQuery objects and depth. |
| `agent/view_tree.js` | Builds the tree and resolves each node id to the real Frappe object. |
| `agent/inspector.js` | Inspector sections, visibility reasons, the element to highlight and the console variables. |
| `agent/ui_tree.js` | frappe-ui mode tree: finds live resources in components, stores and globals. |
| `agent/ui_inspector.js` | frappe-ui mode inspector, Info tab, status and the Reload action. |
| `agent/highlighter.js` | Box that highlights an element on the page. |
| `agent/picker.js` | Element selection mode. |
| `agent/timeline.js` | Timeline recorder: hooks for routes, forms, `set_value`, `frappe.call`, dialogs, messages and socket.io. |
| `agent/agent.js` | Startup, mode detection, `developer_mode` and Frappe 16 checks, hooks and commands. |
| `devtools/` | Creates the Frappe tab with the Frappe "F" icon. |
| `popup/` | Popup of the toolbar button. |
| `panel/panel.js` | Panel entry point. Hands the messages to the views. |
| `panel/connection.js` | Connection between the panel and the background script. |
| `panel/tree_view.js` | Tree view. |
| `panel/inspector_view.js` | Inspector view. The Info, Calls and Timeline tabs use it too. |
| `panel/json_view.js` | Collapsible JSON viewer and table viewer. |
| `panel/info_view.js` | Info tab. |
| `panel/calls_view.js` | Calls tab. |
| `panel/timeline_view.js` | Timeline tab. |
| `icons/frappe-f.svg` | Unchanged copy of `frappe/public/images/frappe-favicon.svg`. |
| `icons/lucide.svg` | The Lucide symbols the panel uses, copied unchanged from Frappe's sprite (`sites/assets/frappe/icons/lucide/icons.svg`). Lucide is ISC licensed. |
| `panel/icons.js` | Draws a sprite icon and maps node kinds, fieldtypes, flags, timeline types, section titles and Info keys to icons. |
| `tests/check_icons.py` | Checks that every icon name the panel and popup use exists in `icons/lucide.svg`. |
| `tests/test_agent.py` | Agent test on a real Desk with Playwright. |
| `tests/test_agent_ui.py` | Agent test on a real frappe-ui app with Playwright. |
| `tests/test_security.py` | Security and transparency tests on a fake development site. No Frappe server needed. |
| `tests/test_background.mjs` | Routing tests for `background.js` with a fake `browser` object. |
| `agent/console_vars.js` | Console variables that never overwrite page globals. |

### Frappe hooks used by the agent

All of them are checked on Frappe 16.52:

| Event | Hook |
|---|---|
| Route change | `frappe.router.on("change")` |
| Form loaded, refreshed, renamed or closed | `$(document).on("form-load form-refresh form-rename form-unload")` |
| Field value change | Wrapped `frappe.model.trigger` |
| Dialog opened or closed | Wrapped `frappe.ui.Dialog.prototype.show` and `hide` |
| Field change with the old value (timeline) | Wrapped `frappe.model.set_value`. It assigns the value synchronously, so the agent compares right after the call. |
| Calls (timeline) | Wrapped `frappe.call`. It returns the jqXHR of `$.ajax`, and the agent adds a `then()` without changing the original. |
| Messages (timeline) | Wrapped `frappe.msgprint` and `frappe.show_alert` |
| Realtime (timeline) | `frappe.realtime.socket.onAny` |

In frappe-ui mode:

| Event | Hook |
|---|---|
| Calls to `/api` | Wrapped `window.fetch`, installed at `document_start`. frappe-ui uses `fetch`. Desk uses `$.ajax`. |
| Resource requests | frappe-ui 1.0 and later keep their config in `globalThis[Symbol.for("frappe-ui.config")]` and create it only if it is missing. The extension creates it first, as a proxy that wraps `resourceFetcher` when the app calls `setConfig`. frappe-ui 0.1.x keeps its config private, so this list stays empty there. |
| Route change | `$router.afterEach` |
| Realtime | `onAny` on the socket from `globalProperties.$socket` or `app.provide("$socket")` |

All app globals are read one key at a time and inside `try`, because some apps define getters that throw (Builder's `$socket` when no socket is set).

Changes in a row are grouped into one tree update every 250 ms. As a safety net, while a panel is open the agent also rebuilds the tree every 1.5 s and sends it only if it changed. Frappe fires `form-refresh` before it computes the field states, and a message can get lost while Firefox restarts the background script, so events alone are not enough. Field flags come from the form's own docfield copy (`control.df`), which `set_df_property()` and `toggle_reqd()` change. Timeline events are sent in batches every 200 ms.

### Node ids

The panel and the agent identify each node with a text id:

| Id | Node |
|---|---|
| `route` | Current route |
| `form` | Form |
| `form/meta` | Meta of the form's DocType |
| `form/tab/<fieldname>` | Tab |
| `form/section/<fieldname>` | Section |
| `form/field/<fieldname>` | Field |
| `form/row/<table>/<name>` | Child table row |
| `list` | List view |
| `dialog/<i>` | Open dialog number `i` |
| `dialog/<i>/field/<fieldname>` | Dialog field |
| `meta`, `meta/<doctype>` | Cached meta |
| `ui/route` | vue-router route (frappe-ui mode) |
| `ui/live` | Live resources (frappe-ui mode) |
| `ui/vm/<uid>`, `ui/store/<id>`, `ui/global/<name>` | Owner of live resources: component, Pinia store or global |
| `<owner id>/<key>` | A live resource (the key is URI-encoded) |
| `ui/requests`, `ui/req/<n>` | Resource requests |

### Messages

From the panel to the agent:

| Type | Data | Answer |
|---|---|---|
| `hello` | | `status` and, if active, `tree` |
| `tree` | | `tree` |
| `inspect` | `id` | `inspect` with `sections` and `consoleVars`, or `missing` |
| `highlight` | `id` or `null` | |
| `pick` | `on` | `picked` with `id`, or `pick-cancelled` |
| `info` | | `info` with `mode`, `summary` and `sections` |
| `action` | `id`, `action` | `action-done` (frappe-ui `reload`) |
| `timeline` | | `timeline` with all recorded events |
| `timeline-clear` | | |
| `status` | | `status` (used by the background script) |

The agent also sends `tree-changed` when the page changes, `timeline-events` with new events and `error` when a command fails. The `status` message has `state`, `reason`, `mode` and, if active, `site`, `user` and `version`. The background script sends `no-page`, `page-connected` and `page-disconnected`.

## Add a development host

Add the pattern to both `matches` blocks of `content_scripts` in `manifest.json`. Then reload the extension. The port does not matter: `*://*.local/*` also matches `mysite.local:8000`.

## Tests

`tests/test_agent.py` opens Desk in Chromium with Playwright and injects the agent scripts. Then it sends the agent the same commands as the panel. It goes through an existing form, a new ToDo, a list and a dialog. It also checks the timeline: field changes with their stack, successful and failed calls, messages and dialogs. It does not save documents.

```sh
python -m venv /tmp/venv-devtools
/tmp/venv-devtools/bin/pip install playwright
/tmp/venv-devtools/bin/playwright install chromium
FRAPPE_URL=http://mysite.local:8000 FRAPPE_HOST_MAP="MAP mysite.local 127.0.0.1" \
FRAPPE_PWD=... /tmp/venv-devtools/bin/python tests/test_agent.py
```

`tests/test_agent_ui.py` does the same on a frappe-ui app. It injects `early.js` before the page scripts, like `document_start` in Firefox. First it opens the app as Guest and checks that the agent stays inactive. Then it logs in and checks the mode, the live resources, the resource requests, the Reload action, the timeline, the route changes and, in development builds, the element picker:

```sh
UI_URL=http://mysite.local:8000/tixevents UI_HOST_MAP="MAP mysite.local 127.0.0.1" \
FRAPPE_PWD=... /tmp/venv-devtools/bin/python tests/test_agent_ui.py
```

To test a development build, start the Vite dev server of the app and point `UI_URL` to it (by default `http://mysite.local:8080/<app>`).

`tests/test_security.py` needs no Frappe server. Playwright serves a fake page on `http://devtest.local` and fakes `/api` and `/desk`. It checks:

- the `fetch` wrapper: JSON and text bodies, `Request` and `URL` inputs, invalid URLs and `abort` behave like the native `fetch`,
- the frappe-ui config object keeps `setConfig` / `getConfig` behavior,
- the bridge drops malformed messages and messages from iframes,
- page data never becomes HTML or runs script in the panel and the popup,
- the agent goes inactive without `developer_mode`, on Frappe 15 and for a Guest, and stops recording,
- **Run again…** runs only after confirmation, and **Reload** runs for read resources,
- console variables do not overwrite page globals,
- the picker stops when the panel closes,
- passwords and keys are hidden.

```sh
/tmp/venv-devtools/bin/python tests/test_security.py
node tests/test_background.mjs
python3 tests/check_icons.py
```

`tests/test_background.mjs` checks that messages reach only the panel and page of the same tab, the toolbar button, the popup status, page reloads, and the `panel-closed` message.

These apps were tested:

| App | frappe-ui | Build | Result |
|---|---|---|---|
| Cubitix storefront | 1.0.0-beta.55 | Production | Inactive as Guest. Logged in: live resources from a Pinia store, resource requests, timeline |
| Cubitix storefront | 1.0.0-beta.55 | Development (Vite) | Also live resources from components and the element picker |
| Builder | 1.0.0-beta.76 | Production | Resource requests and timeline. Its resources live in modules, so there are no live ones. |
| Insights 3.15 | 0.1.261 | Production | Timeline and route changes. No live resources (none in stores or globals). Resource requests empty by design (0.1.x). |
| Insights 3.15 | 0.1.261 | Development (Vite) | Also the app resource `AppSidebar.settings`, its Reload and the element picker. Found and fixed the CSRF problem described in [Security](#security). |

These apps were checked in their source code, not in a browser:

| App | frappe-ui | What to expect |
|---|---|---|
| Helpdesk | 1.0.0-rc.1 | Full support. Its own `resourceFetcher` calls `frappeRequest`, which the hook wraps. Customers of the portal are not Desk users, so the extension stays inactive for them. |
| CRM | 1.0.0-rc.2 | Full support. |
| Gameplan | 1.0.2 | Uses `useCall`, which does not go through `resourceFetcher`. Its calls show in the timeline, not under Resource requests. |
| HRMS | 0.1.105 | Like Insights: timeline and live resources, no Resource requests. The socket comes from `app.provide("$socket")`. Employees without Desk access see the extension inactive. |

The tests run the real extension code, but not inside Firefox, because Playwright cannot load Firefox extensions. Check the extension in Firefox by hand with `web-ext run` before a release.

To check the manifest and the code, and to build the package:

```sh
npx web-ext lint --source-dir .
npx web-ext build --source-dir . --ignore-files tests README.md
```

## Limitations

- Website pages (not Desk and not a frappe-ui app) are not supported.
- In frappe-ui production builds, resources in `<script setup>` components and in plain modules are not reachable as live objects. Use a development build, or look at **Resource requests** and the timeline.
- In frappe-ui apps you must be logged in as a Desk user, because the agent reads `developer_mode` and the Frappe version from `/desk`. This costs one extra request to `/desk` per page load.
- The visibility reasons for a field are a guide only. The agent does not evaluate `depends_on` expressions. It shows only the expressions that exist and what Frappe already computed.
- The Calls tab sees only the calls made while the panel is open. The timeline keeps earlier calls too, but only those made with `frappe.call`.
- The timeline does not see changes that skip `frappe.model.set_value`, such as `frm.doc.field = value`.
- The timeline record is lost when the page reloads, because it lives in the page.
- The Frappe favicon uses `prefers-color-scheme` to turn white in a dark theme. If your Firefox theme does not apply it, the "F" stays black.
- On tabs without Frappe the button is disabled, so its popup does not open.

## Next steps

1. **Live editing:** change values and df properties (`hidden`, `reqd`, `read_only`) from the inspector.
2. **Open the stack in the debugger:** jump from a line of the JS stack to the file in the Debugger tab.
3. **Configurable hosts** from an options page.
