// Inspector for frappe-ui apps: sections for each node, console variables,
// the element to highlight, the Reload action, the Info tab and the status message.

(() => {
  const NS = (window.FrappeDevtools ??= {});

  class UiInspector {
    constructor(tree) {
      this.tree = tree;
      this.serializer = new NS.Serializer({ maxDepth: 5 });
    }

    inspect(target) {
      const sections = this.sectionsFor(target).map((s) => this.serializeSection(s));
      const actions = target.kind === "resource" ? [reloadAction(target.resource)] : [];
      return { sections, consoleVars: this.exposeToConsole(target), actions };
    }

    sectionsFor(t) {
      switch (t.kind) {
        case "route": return this.routeSections(t.router);
        case "live": return [section("Where live resources are found", liveHelp(), true)];
        case "owner": return this.ownerSections(t.owner);
        case "resource": return this.resourceSections(t.resource, t.owner);
        case "requests": return [section("Resources seen by resourceFetcher", t.entries.map(requestSummary), true)];
        case "request": return this.requestSections(t.entry);
        default: return [];
      }
    }

    routeSections(router) {
      const route = router.currentRoute.value;
      return [
        section("Current route", {
          fullPath: route.fullPath,
          name: route.name,
          params: route.params,
          query: route.query,
          hash: route.hash,
          meta: route.meta,
          matched: route.matched.map((m) => ({ path: m.path, name: m.name })),
        }, true),
        section("All routes", router.getRoutes().map((r) => ({ path: r.path, name: r.name }))),
      ];
    }

    ownerSections(owner) {
      return [
        section("Owner", { kind: owner.kind, name: owner.label, resources: owner.resources.map((r) => r.key) }, true),
        ...owner.resources.map(({ key, resource }) => section(key, stateOf(resource))),
      ];
    }

    resourceSections(r, owner) {
      const sections = [
        section("State", stateOf(r), true),
        section("Data", "doc" in r ? r.doc : r.data, true),
      ];
      if (r.error) sections.push(errorSection(r.error));
      if (r.params) sections.push(section("Params", r.params));
      if ("list" in r && r.list) sections.push(section("List options", listOptions(r)));
      if ("previousData" in r) sections.push(section("Previous data", r.previousData));
      sections.push(section("Owner", { kind: owner.kind, name: owner.label }));
      return sections;
    }

    requestSections(e) {
      const sections = [
        section("Summary", requestSummary(e), true),
        section("Last params", e.lastParams, true),
        section("Last data", e.lastData),
      ];
      if (e.lastError) {
        sections.push(section("Last error", { message: e.lastError.message, exc_type: e.lastError.exc_type }, true));
        if (e.lastError.traceback) sections.push({ title: "Server traceback", text: String(e.lastError.traceback), open: true });
      }
      if (e.lastStack) sections.push({ title: "JS stack (who caused it)", text: e.lastStack });
      return sections;
    }

    serializeSection(s) {
      if (s.text !== undefined) return s;
      return { title: s.title, open: s.open, value: this.serializer.serialize(s.value) };
    }

    exposeToConsole(t) {
      const router = this.tree.router;
      const vars = {
        $resource: t.resource,
        $vm: t.owner?.vm?.proxy,
        $store: t.owner?.store,
        $router: router || undefined,
        $route: router?.currentRoute.value,
        $app: this.tree.app,
      };
      return NS.setConsoleVars(vars);
    }

    // reload() repeats the last request with the same params. For a resource that can
    // change data (a payment, an insert, a delete) that needs an explicit confirmation.
    action(target, name, confirmed = false) {
      if (target.kind !== "resource" || name !== "reload") return null;
      if (!isReadOnly(target.resource) && !confirmed) return "Not run: this resource can change data and needs confirmation";
      const r = target.resource;
      if (typeof r.reload === "function") r.reload();
      else r.load();
      return "Reload started";
    }

    // First DOM element of a component, to highlight it.
    element(t) {
      const vm = t.owner?.vm;
      return vm ? firstElement(vm.subTree) : null;
    }

    info() {
      const boot = window.frappe?.boot;
      const config = globalThis[Symbol.for("frappe-ui.config")];
      const stores = this.tree.global("$pinia")?._s;
      return {
        summary: {
          site: siteName(),
          user: userName(),
          vue: this.tree.app.version,
          router: this.tree.router ? "vue-router" : "none",
          pinia_stores: stores ? [...stores.keys()] : [],
          frappe_ui_config: NS.early?.configTouched ? "global (frappe-ui 1.0+)" : "private (frappe-ui 0.1.x)",
        },
        sections: [
          { title: "Boot (window.frappe.boot)", value: this.serializer.serialize(boot ?? null) },
          { title: "frappe-ui config", value: this.serializer.serialize(config ? { ...config } : null) },
          { title: "Global properties", value: this.serializer.serialize(Object.keys(this.tree.app.config.globalProperties)) },
        ],
      };
    }

    statusInfo() {
      return { site: siteName(), user: userName(), version: `frappe-ui app · Vue ${this.tree.app.version}` };
    }
  }

  // "app resource (load)": load() fetches the document again (Insights 3 useDocumentResource).
  const READ_TYPES = new Set(["createListResource", "createDocumentResource", "useList", "useDoc", "app resource (load)"]);
  const READ_METHOD = /(^|\.)(get(_[a-z0-9_]+)?|search[a-z0-9_]*|whoami|ping)$/;

  // Read resources: lists, documents, auto-loaded resources, GET requests and get_* / search methods.
  function isReadOnly(r) {
    if (READ_TYPES.has(NS.ui.resourceType(r)) || r.auto) return true;
    if (String(r.method || "").toUpperCase() === "GET") return true;
    return READ_METHOD.test(String(r.url || ""));
  }

  function reloadAction(r) {
    if (isReadOnly(r)) return { name: "reload", label: "Reload" };
    return {
      name: "reload",
      label: "Run again…",
      confirm: `This resource can change data on the server (${r.url}). Click again to send the same request with the same params.`,
    };
  }

  function stateOf(r) {
    const state = { type: NS.ui.resourceType(r) };
    for (const key of ["url", "method", "doctype", "name", "loading", "fetched", "isFinished", "auto", "error"]) {
      if (key in r && r[key] !== undefined) state[key] = key === "error" && r.error ? errorMessage(r.error) : r[key];
    }
    return state;
  }

  function listOptions(r) {
    const { doctype, fields, filters, orFilters, orderBy, start, pageLength, groupBy, hasNextPage } = r;
    return { doctype, fields, filters, orFilters, orderBy, start, pageLength, groupBy, hasNextPage };
  }

  function errorSection(error) {
    const traceback = Array.isArray(error.exc) ? error.exc.join("\n") : error.exc;
    if (traceback) return { title: "Server traceback", text: String(traceback), open: true };
    return section("Error", { message: errorMessage(error), exc_type: error.exc_type, messages: error.messages }, true);
  }

  function errorMessage(error) {
    return error?.message || String(error);
  }

  function requestSummary(e) {
    return {
      url: e.url,
      method: e.method,
      doctype: e.doctype ?? undefined,
      cache: e.cache ?? undefined,
      calls: e.calls,
      loading: e.loading,
      last_duration_ms: e.lastDuration,
      last_at: e.lastAt ? new Date(e.lastAt).toISOString() : undefined,
      error: e.lastError?.message,
    };
  }

  function liveHelp() {
    return [
      "Component setup state (<script setup> exposes it only in development builds, such as the Vite dev server)",
      "Options API resources: {...} (also in production builds)",
      "Pinia stores and app.config.globalProperties / app.provide (also in production builds)",
    ];
  }

  function firstElement(vnode) {
    if (!vnode) return null;
    if (vnode.el?.nodeType === 1) return vnode.el;
    if (vnode.component) return firstElement(vnode.component.subTree);
    if (Array.isArray(vnode.children)) {
      for (const child of vnode.children) {
        const found = firstElement(child);
        if (found) return found;
      }
    }
    return null;
  }

  function siteName() {
    const boot = window.frappe?.boot;
    return boot?.sitename || boot?.site_name || window.site_name || location.hostname;
  }

  // Frappe sets a readable user_id cookie on login.
  function userName() {
    const match = document.cookie.match(/(?:^|;\s*)user_id=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : "Guest";
  }

  function section(title, value, open = false) {
    return { title, value, open };
  }

  NS.UiInspector = UiInspector;
})();
