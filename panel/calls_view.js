// Calls tab: lists the Frappe API calls (v1 and v2) seen on the network,
// with decoded arguments, response, traceback and server messages.

const API_RE = /\/api\/(v\d+\/)?(method|resource|document|doctype)\//;
const MAX_CALLS = 500;

class CallsView {
  constructor({ body, detail, filter, errorsOnly, clear }) {
    this.body = body;
    this.detail = new InspectorView(detail, { emptyText: EMPTY_TEXT.calls });
    this.filter = filter;
    this.errorsOnly = errorsOnly;
    this.enabled = false; // Records only on development sites with the agent active.
    filter.addEventListener("input", () => this.applyFilter());
    errorsOnly.addEventListener("change", () => this.applyFilter());
    clear.addEventListener("click", () => this.clear());
    browser.devtools.network.onRequestFinished.addListener((entry) => this.onRequest(entry));
  }

  async onRequest(entry) {
    if (!this.enabled || !API_RE.test(entry.request.url)) return;
    const call = await readCall(entry);
    this.body.prepend(this.row(call));
    while (this.body.rows.length > MAX_CALLS) this.body.lastElementChild.remove();
  }

  row(call) {
    const tr = el("tr");
    tr.className = call.failed ? "err" : "";
    tr.dataset.search = `${call.name} ${call.url}`.toLowerCase();
    [call.verb, call.name, call.status, call.ms].forEach((v) => tr.appendChild(el("td", null, String(v))));
    tr.addEventListener("click", () => {
      this.body.querySelector("tr.selected")?.classList.remove("selected");
      tr.classList.add("selected");
      this.detail.render({ sections: callSections(call) }, { label: call.name, detail: `${call.verb} ${call.status}` });
    });
    this.matchRow(tr);
    return tr;
  }

  applyFilter() {
    for (const tr of this.body.rows) this.matchRow(tr);
  }

  matchRow(tr) {
    const q = this.filter.value.trim().toLowerCase();
    const okText = !q || tr.dataset.search.includes(q);
    const okError = !this.errorsOnly.checked || tr.classList.contains("err");
    tr.hidden = !(okText && okError);
  }

  clear() {
    this.body.replaceChildren();
    this.detail.empty();
  }
}

async function readCall(entry) {
  const { request, response, time } = entry;
  let text = "";
  try {
    [text] = await entry.getContent();
  } catch (_) {
    // Some responses (cancelled, redirects) have no content.
  }
  const json = tryJson(text);
  const url = new URL(request.url);
  return {
    url: request.url,
    verb: request.method,
    name: url.pathname.replace(/^\/api\/(v\d+\/)?(method\/)?/, ""),
    status: response.status,
    ms: Math.round(time),
    args: requestArgs(request, url),
    json,
    text,
    failed: response.status >= 400 || Boolean(json?.exc || json?.exception || json?.errors),
  };
}

function callSections(call) {
  const j = call.json || {};
  const sections = [
    { title: "Request", value: { url: call.url, verb: call.verb, args: call.args }, open: true },
  ];
  const traceback = tracebackText(j);
  if (traceback) sections.push({ title: "Traceback", text: traceback, open: true });
  const serverMessages = decodeList(j._server_messages);
  if (serverMessages) sections.push({ title: "Server messages (msgprint)", value: serverMessages, open: true });
  const debug = decodeList(j._debug_messages);
  if (debug) sections.push({ title: "Debug messages (errprint)", value: debug, open: true });
  sections.push({ title: "Response", value: "message" in j ? j.message : j.data ?? call.json ?? call.text, open: !traceback });
  sections.push({ title: "Full response", value: call.json ?? call.text });
  return sections;
}

// v1 sends `exc` (a list of tracebacks as JSON text). v2 sends `errors[].exception`.
function tracebackText(j) {
  if (j.exc) {
    const list = tryJson(j.exc);
    return Array.isArray(list) ? list.join("\n") : String(j.exc);
  }
  if (Array.isArray(j.errors)) return j.errors.map((e) => e.exception || e.message).filter(Boolean).join("\n\n");
  return j.exception ? String(j.exception) : "";
}

// `_server_messages` is JSON text with a list of JSON texts.
function decodeList(raw) {
  const list = tryJson(raw);
  return Array.isArray(list) ? list.map((item) => tryJson(item) ?? item) : null;
}

// Merges the arguments of the query string and the body. JSON values are decoded.
function requestArgs(request, url) {
  const args = {};
  for (const [k, v] of url.searchParams) args[k] = decodeValue(v);
  const post = request.postData;
  if (post?.params?.length) {
    // Firefox can give the HAR params still form-encoded.
    for (const p of post.params) args[safeDecode(p.name)] = decodeValue(safeDecode(p.value));
  } else if (post?.text) {
    const body = tryJson(post.text);
    if (body && typeof body === "object") Object.assign(args, body);
    else for (const [k, v] of new URLSearchParams(post.text)) args[k] = decodeValue(v);
  }
  return args;
}

function decodeValue(value) {
  return /^[[{]/.test(value) ? tryJson(value) ?? value : value;
}

function safeDecode(text) {
  try {
    return decodeURIComponent(String(text).replace(/\+/g, " "));
  } catch (_) {
    return text;
  }
}

function tryJson(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}
