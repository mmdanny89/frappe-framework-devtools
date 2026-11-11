// Runs at document_start in the page (MAIN world), before any app script.
// frappe-ui apps start fetching while they boot, so these hooks must exist first:
//   1. window.fetch: every /api call, with the JS stack of the caller (frappe-ui uses fetch, Desk uses $.ajax).
//   2. frappe-ui config: frappe-ui keeps its config in globalThis[Symbol.for("frappe-ui.config")]
//      and creates it only if it is missing. Creating it first lets us wrap `resourceFetcher`,
//      which every createResource / createListResource / createDocumentResource fetch goes through.
//
// Rules, so that the hooks never change the app:
//   - the real fetch / resourceFetcher is always called first, and with the same arguments,
//   - all hook code runs inside try/catch,
//   - response bodies are read only when they are JSON and small, and only while recording,
//   - the agent calls disable() when the page is not a supported development site.

(() => {
  const NS = (window.FrappeDevtools ??= {});
  if (NS.early) return;

  const MAX_BUFFER = 200;
  const MAX_RESOURCES = 300;
  const MAX_BODY_BYTES = 2 * 1024 * 1024;
  const CONFIG_KEY = Symbol.for("frappe-ui.config");
  const SECRET_KEY = /pwd|passw|secret|token|api_?key|otp|signature|card|cvv/i;

  class EarlyHooks {
    constructor() {
      this.recording = true; // false after disable(): the hooks stay but do nothing
      this.calls = []; // fetch calls not yet read by the agent
      this.resources = new Map(); // resource key -> what resourceFetcher saw
      this.configTouched = false; // true once the app calls setConfig
      this.onCall = null; // set by the agent: (call) => void
      this.onResource = null; // set by the agent: (entry) => void
      this.seq = 0;
    }

    install() {
      this.hookFetch();
      this.hookFrappeUiConfig();
    }

    // The page is not a supported site: stop recording and drop what was buffered.
    disable() {
      this.recording = false;
      this.calls = [];
      this.resources.clear();
      this.onCall = null;
      this.onResource = null;
    }

    hookFetch() {
      const hooks = this;
      const originalFetch = window.fetch;
      this.originalFetch = originalFetch;
      window.fetch = function (input, init) {
        const promise = originalFetch.apply(this, arguments);
        if (hooks.recording) {
          try {
            hooks.maybeWatch(input, init, promise);
          } catch (_) {
            // Never let the hook change the app's request.
          }
        }
        return promise;
      };
    }

    maybeWatch(input, init, promise) {
      const url = new URL(typeof input === "string" ? input : input?.url || String(input), location.href);
      if (url.origin !== location.origin || !/^\/api\//.test(url.pathname)) return;
      const call = {
        t: Date.now(),
        method: (init?.method || input?.method || "GET").toUpperCase(),
        path: url.pathname,
        name: url.pathname.replace(/^\/api\/(v\d+\/)?(method\/)?/, ""),
        args: redact(requestArgs(url, init?.body)),
        stack: captureStack(),
      };
      const started = performance.now();
      promise.then(
        (response) => this.finishCall(call, started, response),
        (error) => {
          call.status = 0;
          call.duration = Math.round(performance.now() - started);
          call.networkError = String(error);
          this.emitCall(call);
        }
      );
    }

    async finishCall(call, started, response) {
      try {
        call.status = response.status;
        call.duration = Math.round(performance.now() - started);
        call.json = await readSmallJson(response);
        this.emitCall(call);
      } catch (_) {
        // A body we cannot read is not worth breaking anything for.
      }
    }

    emitCall(call) {
      if (!this.recording) return;
      if (this.onCall) return this.onCall(call);
      this.calls.push(call);
      if (this.calls.length > MAX_BUFFER) this.calls.shift();
    }

    // moduleSingleton() in frappe-ui uses this object if it already exists.
    hookFrappeUiConfig() {
      if (CONFIG_KEY in globalThis) return;
      const hooks = this;
      globalThis[CONFIG_KEY] = new Proxy({}, {
        set(target, key, value) {
          hooks.configTouched = true;
          target[key] = key === "resourceFetcher" && typeof value === "function" ? hooks.wrapFetcher(value) : value;
          return true;
        },
      });
    }

    // resourceFetcher gets a copy of the resource options (url, params, cache…) on every fetch.
    wrapFetcher(fetcher) {
      const hooks = this;
      return function (options) {
        const result = fetcher.apply(this, arguments);
        if (hooks.recording) {
          try {
            hooks.watchResource(options, result);
          } catch (_) {
            // Never let the hook change the app's request.
          }
        }
        return result;
      };
    }

    watchResource(options, result) {
      const entry = this.resourceEntry(options || {});
      const started = performance.now();
      entry.loading = true;
      entry.calls += 1;
      entry.lastParams = redact(options?.params ?? null);
      entry.lastStack = captureStack();
      this.onResource?.(entry);
      Promise.resolve(result).then(
        (data) => this.finishResource(entry, started, { data }),
        (error) => this.finishResource(entry, started, { error })
      );
    }

    resourceEntry(options) {
      const key = resourceKey(options);
      if (!this.resources.has(key)) {
        if (this.resources.size >= MAX_RESOURCES) this.resources.delete(this.resources.keys().next().value);
        this.resources.set(key, {
          key,
          id: ++this.seq,
          url: options.url,
          method: options.method || "POST",
          cache: options.cache ?? null,
          doctype: options.params?.doctype ?? options.doctype ?? null,
          calls: 0,
          loading: false,
        });
      }
      return this.resources.get(key);
    }

    finishResource(entry, started, { data, error }) {
      try {
        entry.loading = false;
        entry.lastDuration = Math.round(performance.now() - started);
        entry.lastAt = Date.now();
        entry.lastData = error ? entry.lastData : data;
        entry.lastError = error ? describeError(error) : null;
        if (this.recording) this.onResource?.(entry);
      } catch (_) {
        // Recording is best effort.
      }
    }
  }

  // Reads a clone of the response only if it is JSON and small. Streams and files are left alone.
  async function readSmallJson(response) {
    const type = response.headers.get("content-type") || "";
    const length = Number(response.headers.get("content-length") || 0);
    if (!type.includes("json") || length > MAX_BODY_BYTES) return null;
    const text = await response.clone().text();
    if (text.length > MAX_BODY_BYTES) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  // The same cache key means the same resource. Without one, the URL (plus doctype for lists).
  function resourceKey(options) {
    if (options.cache) {
      try {
        return `cache:${JSON.stringify(options.cache)}`;
      } catch (_) {
        return `cache:${String(options.cache)}`;
      }
    }
    const doctype = options.params?.doctype;
    return doctype ? `${options.url}:${doctype}` : String(options.url);
  }

  // Hides passwords, tokens and similar values before they are stored in the page.
  function redact(args) {
    if (!args || typeof args !== "object" || Array.isArray(args)) return args;
    const out = {};
    for (const [key, value] of Object.entries(args)) out[key] = SECRET_KEY.test(key) ? "***" : value;
    return out;
  }

  function describeError(error) {
    return {
      message: error?.message || String(error),
      exc_type: error?.exc_type,
      traceback: Array.isArray(error?.exc) ? error.exc.join("\n") : error?.exc,
    };
  }

  // Arguments from the query string and from a JSON or form body.
  function requestArgs(url, body) {
    const args = Object.fromEntries(url.searchParams);
    if (typeof body === "string") {
      try {
        Object.assign(args, JSON.parse(body));
      } catch (_) {
        for (const [k, v] of new URLSearchParams(body)) args[k] = v;
      }
    } else if (body instanceof URLSearchParams || body instanceof FormData) {
      for (const [k, v] of body) args[k] = typeof v === "string" ? v : `[${v?.constructor?.name || "file"}]`;
    }
    return args;
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

  NS.early = new EarlyHooks();
  NS.early.install();
  NS.captureStack = captureStack;
  NS.redact = redact;
})();
