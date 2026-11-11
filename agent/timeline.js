// Timeline: records what happens in Desk (routes, forms, field changes, frappe.call,
// dialogs, messages and socket.io events) with the JS stack of whoever caused it.
// It records from the moment the agent becomes active, even while the panel is closed.

(() => {
  const NS = (window.FrappeDevtools ??= {});

  const MAX_EVENTS = 1000;
  const FLUSH_DELAY_MS = 200;
  const INDICATOR_LEVEL = { red: "error", orange: "warn", yellow: "warn" };

  class Timeline {
    // send(msg) sends to the panel. isLive() tells if the panel is connected.
    constructor({ send, isLive }) {
      this.send = send;
      this.isLive = isLive;
      this.events = [];
      this.pending = [];
      this.seq = 0;
      this.serializer = new NS.Serializer({ maxDepth: 3, maxKeys: 100, maxItems: 50 });
    }

    // Frappe Desk: frappe.call goes through $.ajax, so calls come from the frappe.call hook.
    installDesk() {
      if (NS.early) NS.early.calls = [];
      this.hookRouter();
      this.hookForms();
      this.hookSetValue();
      this.hookCalls();
      this.hookDialogs();
      this.hookMessages();
      this.hookSocket(frappe.realtime?.socket);
    }

    // frappe-ui apps: calls come from the window.fetch hook in early.js (also the ones made while booting).
    // tree.global() reads app globals safely (some apps define getters that throw).
    installUi(tree) {
      const router = tree.router;
      router?.afterEach((to, from) => {
        this.record("route", to.fullPath, { detail: `from ${from.fullPath}`, data: { name: to.name, params: to.params, query: to.query } });
      });
      for (const call of NS.early?.calls || []) this.recordFetch(call);
      if (NS.early) NS.early.calls = [];
      this.hookSocket(tree.global("$socket"));
    }

    // A call seen by the fetch hook, plus the server messages it carried.
    recordFetch(call) {
      const json = call.json || {};
      const failed = call.status >= 400 || call.status === 0 || Boolean(json.exc || json.exception || json.errors);
      this.record("call", call.name, {
        detail: failed ? `${call.status} ${json.exc_type || call.networkError || "error"}` : `${call.duration} ms`,
        level: failed ? "error" : "info",
        duration: call.duration,
        data: {
          verb: call.method,
          args: call.args,
          response: failed ? undefined : json.message ?? json.data,
          error: failed ? { status: call.status, exc_type: json.exc_type, exception: json.exception, network: call.networkError } : undefined,
          traceback: failed ? tracebackText(json.exc) || errorsText(json.errors) : undefined,
        },
        stack: call.stack,
      });
      // The server messages belong to this call, so they get its stack.
      for (const message of decodeList(json._server_messages)) this.recordMessage(message, "server", call.stack);
    }

    all() {
      return this.events;
    }

    clear() {
      this.events = [];
      this.pending = [];
    }

    // cat: route | form | field | call | dialog | msg | realtime
    record(cat, title, { detail = "", level = "info", data, stack, duration } = {}) {
      const event = {
        id: ++this.seq,
        t: Date.now(),
        cat,
        title: String(title),
        detail: String(detail),
        level,
        data: this.serializer.serialize(data),
        stack,
        duration,
      };
      this.events.push(event);
      if (this.events.length > MAX_EVENTS) this.events.shift();
      if (this.isLive()) this.schedule(event);
    }

    schedule(event) {
      this.pending.push(event);
      if (this.flushTimer) return;
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.send({ type: "timeline-events", events: this.pending });
        this.pending = [];
      }, FLUSH_DELAY_MS);
    }

    hookRouter() {
      let previous = location.pathname;
      frappe.router.on("change", () => {
        this.record("route", location.pathname, { detail: `from ${previous}`, data: { route: frappe.get_route() } });
        previous = location.pathname;
      });
    }

    hookForms() {
      $(document).on("form-load form-refresh form-rename form-unload", (e, frm) => {
        if (!frm) return;
        this.record("form", `${frm.doctype} ${frm.docname}`, {
          detail: e.type.replace("form-", ""),
          data: { doctype: frm.doctype, name: frm.docname, docstatus: frm.doc?.docstatus, is_dirty: frm.is_dirty?.() },
        });
      });
    }

    // set_value assigns the value synchronously and runs the triggers later.
    // So the old value is saved before the call and compared right after it.
    hookSetValue() {
      const timeline = this;
      wrap(frappe.model, "set_value", (original, self, args) => {
        let snap = null;
        safely(() => {
          const [doctype, docname, fieldname] = args;
          const plain = $.isPlainObject(doctype);
          const doc = plain ? doctype : locals[doctype]?.[docname];
          const target = plain ? docname : fieldname;
          const keys = $.isPlainObject(target) ? Object.keys(target) : [target];
          snap = { doc, keys, before: Object.fromEntries(keys.map((k) => [k, doc?.[k]])), stack: captureStack() };
        });

        const result = original.apply(self, args);
        safely(() => {
          const { doc, keys, before, stack } = snap || {};
          for (const key of keys || []) {
            if (doc && doc[key] !== before[key]) timeline.recordFieldChange(doc, key, before[key], stack);
          }
        });
        return result;
      });
    }

    recordFieldChange(doc, fieldname, oldValue, stack) {
      const newValue = doc[fieldname];
      this.record("field", `${doc.doctype}.${fieldname}`, {
        detail: `${short(oldValue)} → ${short(newValue)}`,
        data: {
          doctype: doc.doctype,
          name: doc.name,
          parent: doc.parent ? `${doc.parenttype} ${doc.parent} (row ${doc.idx})` : undefined,
          fieldname,
          old: oldValue,
          new: newValue,
        },
        stack,
      });
    }

    // frappe.call returns the jqXHR of $.ajax. A then() is added without changing the original.
    hookCalls() {
      const timeline = this;
      wrap(frappe, "call", (original, self, args) => {
        const started = performance.now();
        const stack = captureStack();
        const result = original.apply(self, args);
        safely(() => {
          const opts = typeof args[0] === "string" ? { method: args[0], args: args[1] } : args[0] || {};
          result?.then?.(
            (r) => safely(() => timeline.recordCall(opts, started, stack, { response: r })),
            (xhr) => safely(() => timeline.recordCall(opts, started, stack, { xhr }))
          );
        });
        return result;
      });
    }

    recordCall(opts, started, stack, { response, xhr }) {
      const failed = Boolean(xhr) || Boolean(response?.exc);
      const json = xhr?.responseJSON || response || {};
      const method = opts.doc ? `${opts.doc.doctype}.${opts.method}` : opts.method || "(no method)";
      const duration = Math.round(performance.now() - started);
      this.record("call", method, {
        detail: failed ? `${xhr?.status || ""} ${json.exc_type || "error"}`.trim() : `${duration} ms`,
        level: failed ? "error" : "info",
        duration,
        data: {
          args: opts.args,
          response: failed ? undefined : response?.message,
          error: failed ? { status: xhr?.status, exc_type: json.exc_type, exception: json.exception } : undefined,
          traceback: failed ? tracebackText(json.exc) : undefined,
        },
        stack,
      });
    }

    hookDialogs() {
      const timeline = this;
      const proto = frappe.ui.Dialog.prototype;
      wrap(proto, "show", (original, self, args) => {
        safely(() => timeline.record("dialog", self.title || "Dialog", { detail: "opened", stack: captureStack() }));
        return original.apply(self, args);
      });
      // hide() is also called on dialogs that are already closed. Only count it if the dialog was visible.
      wrap(proto, "hide", (original, self, args) => {
        safely(() => self.display && timeline.record("dialog", self.title || "Dialog", { detail: "closed" }));
        return original.apply(self, args);
      });
    }

    // frappe.throw and the server messages (_server_messages) also go through msgprint.
    hookMessages() {
      const timeline = this;
      wrap(frappe, "msgprint", (original, self, args) => {
        safely(() => {
          const [msg, title] = args;
          const data = msg && normalizeMessage(msg, title);
          // With a list or with alert/toast, msgprint calls itself or show_alert.
          // Only that second call is recorded, so there are no duplicates.
          const forwards = data && (Array.isArray(data.message) || data.alert || data.toast);
          if (data && !forwards) timeline.recordMessage(data, "msgprint");
        });
        return original.apply(self, args);
      });
      wrap(frappe, "show_alert", (original, self, args) => {
        safely(() => args[0] && timeline.recordMessage(normalizeMessage(args[0]), "alert"));
        return original.apply(self, args);
      });
    }

    recordMessage(data, kind, stack = captureStack()) {
      this.record("msg", plainText(data.message).slice(0, 200) || "(empty)", {
        detail: [kind, data.title && plainText(data.title)].filter(Boolean).join(" · "),
        level: INDICATOR_LEVEL[data.indicator] || "info",
        data,
        stack,
      });
    }

    // socket.io v4 can listen to every event with onAny.
    hookSocket(socket) {
      if (!socket?.onAny) return;
      socket.onAny((event, ...payload) => {
        this.record("realtime", event, { data: payload.length === 1 ? payload[0] : payload });
      });
    }
  }

  // Recording is best effort: an error while recording must never stop Frappe's own function.
  function safely(fn) {
    try {
      fn();
    } catch (e) {
      console.debug("[Frappe Framework DevTools] could not record an event", e);
    }
  }

  // Replaces obj[name] with a function that gets (original, this, args).
  function wrap(obj, name, around) {
    const original = obj[name];
    if (typeof original !== "function") return;
    obj[name] = function (...args) {
      return around(original, this, args);
    };
  }

  // JS stack without the lines of the extension itself.
  function captureStack() {
    return (new Error().stack || "")
      .split("\n")
      // Chromium starts the stack with an "Error" line. Firefox does not.
      .filter((line) => line && line !== "Error" && !/moz-extension:|chrome-extension:|\/agent\//.test(line))
      .slice(0, 12)
      .join("\n");
  }

  // No jQuery here: frappe-ui apps do not load it.
  function normalizeMessage(msg, title) {
    if (msg && typeof msg === "object" && !Array.isArray(msg)) return { ...msg };
    if (typeof msg === "string" && msg.startsWith("{")) {
      try {
        return JSON.parse(msg);
      } catch (_) {
        // Not JSON. Treat it as text.
      }
    }
    return { message: msg, title };
  }

  // Strips HTML without running it: DOMParser does not run scripts or load images.
  function plainText(html) {
    if (typeof html !== "string") return String(html ?? "");
    const spaced = html.replace(/<br\s*\/?>/gi, " "); // a <br> leaves no space in textContent
    return new DOMParser().parseFromString(spaced, "text/html").body.textContent.trim().replace(/\s+/g, " ");
  }

  // v2 API errors: [{ type, message, exception }].
  function errorsText(errors) {
    if (!Array.isArray(errors)) return undefined;
    return errors.map((e) => e.exception || e.message).filter(Boolean).join("\n\n") || undefined;
  }

  // `_server_messages` is JSON text with a list of JSON texts.
  function decodeList(raw) {
    if (!raw) return [];
    try {
      return JSON.parse(raw).map((item) => {
        try {
          return normalizeMessage(JSON.parse(item));
        } catch (_) {
          return { message: item };
        }
      });
    } catch (_) {
      return [];
    }
  }

  function tracebackText(exc) {
    if (!exc) return undefined;
    try {
      const list = JSON.parse(exc);
      return Array.isArray(list) ? list.join("\n") : String(exc);
    } catch (_) {
      return String(exc);
    }
  }

  function short(value) {
    if (value === undefined || value === null || value === "") return "∅";
    let text;
    try {
      text = typeof value === "object" ? JSON.stringify(value) : String(value);
    } catch (_) {
      text = "[object]"; // circular references
    }
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  }

  NS.Timeline = Timeline;
})();
