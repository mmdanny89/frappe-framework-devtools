// Tree for frappe-ui apps (Vue 3): route, live resources and resource requests.
//
// frappe-ui keeps no registry of resources, so live ones are found where the app holds them:
//   - component setup state (<script setup> exposes it only in development builds),
//   - Options API `resources: {...}` (this._resources, also in production builds),
//   - Pinia stores and app.config.globalProperties (also in production builds).
// "Requests" lists what the frappe-ui resourceFetcher saw (frappe-ui 1.0 and later, see early.js).
//
// Node ids:
//   ui/route
//   ui/live, ui/vm/<uid>, ui/store/<id>, ui/global/<name>   (owners of live resources)
//   <owner id>/<key>                                         (a live resource; key is URI-encoded)
//   ui/requests, ui/req/<n>

(() => {
  const NS = (window.FrappeDevtools ??= {});

  const MAX_COMPONENTS = 3000;

  class UiTree {
    constructor(app) {
      this.app = app;
      this.router = this.global("$router") || null;
    }

    // An app global from globalProperties or app.provide(). Read one key at a time:
    // some apps define getters that throw (Builder's $socket when no socket is set).
    global(name) {
      return safeGet(this.app.config.globalProperties, name) ?? safeGet(this.app._context.provides, name);
    }

    build() {
      const nodes = [];
      if (this.router) nodes.push(node("ui/route", this.router.currentRoute.value.fullPath, "route"));
      nodes.push(this.liveNode(), this.requestsNode());
      return nodes;
    }

    resolve(id) {
      if (id === "ui/route") return this.router ? { kind: "route", router: this.router } : null;
      if (id === "ui/live") return { kind: "live" };
      if (id === "ui/requests") return { kind: "requests", entries: this.requests() };
      if (id.startsWith("ui/req/")) {
        const entry = this.requests().find((e) => String(e.id) === id.slice(7));
        return entry ? { kind: "request", entry } : null;
      }
      return this.resolveLive(id);
    }

    // Element picker. Vue links DOM elements to components only in development builds.
    locate(el) {
      const owners = new Set(this.owners().map((o) => o.id));
      for (let vm = el.closest("*")?.__vueParentComponent; vm; vm = vm.parent) {
        if (owners.has(`ui/vm/${vm.uid}`)) return `ui/vm/${vm.uid}`;
      }
      return null;
    }

    liveNode() {
      const owners = this.owners();
      const count = owners.reduce((n, o) => n + o.resources.length, 0);
      return node("ui/live", "Live resources", "live", {
        detail: `${count} in ${owners.length} owners`,
        children: owners.map((o) =>
          node(o.id, o.label, o.kind, {
            detail: o.detail,
            children: o.resources.map(({ key, resource }) => resourceNode(`${o.id}/${encodeURIComponent(key)}`, key, resource)),
          })
        ),
      });
    }

    requestsNode() {
      const entries = this.requests();
      return node("ui/requests", "Resource requests", "requests", {
        detail: NS.early?.configTouched ? `${entries.length}` : "needs frappe-ui 1.0+",
        children: entries.map((e) =>
          node(`ui/req/${e.id}`, e.url || e.key, "request", {
            detail: [e.doctype, `${e.calls}×`].filter(Boolean).join(" · "),
            flags: [e.loading && "loading", e.lastError && "error"].filter(Boolean),
          })
        ),
      });
    }

    requests() {
      return [...(NS.early?.resources.values() || [])];
    }

    // Everything that holds at least one live resource: components, stores, globals.
    owners() {
      return [...this.componentOwners(), ...this.storeOwners(), ...this.globalOwners()];
    }

    componentOwners() {
      const out = [];
      for (const vm of this.components()) {
        const resources = [
          ...findResources(vm.setupState),
          ...findResources(vm.proxy?._resources, "resources."),
        ];
        if (resources.length) {
          out.push({ id: `ui/vm/${vm.uid}`, kind: "component", label: componentName(vm), detail: `<${vm.uid}>`, vm, resources });
        }
      }
      return out;
    }

    storeOwners() {
      const stores = this.global("$pinia")?._s;
      if (!stores) return [];
      return [...stores.entries()]
        .map(([storeId, store]) => ({ id: `ui/store/${storeId}`, kind: "store", label: storeId, detail: "Pinia", store, resources: findResources(store) }))
        .filter((o) => o.resources.length);
    }

    // A global can be a resource, or an object that holds resources (one level down).
    globalOwners() {
      const names = new Set([...Object.keys(this.app.config.globalProperties), ...Object.keys(this.app._context.provides)]);
      const out = [];
      for (const name of names) {
        if (name === "$pinia" || name === "$router" || name === "$route") continue;
        const value = this.global(name);
        const resources = isResource(value) ? [{ key: name, resource: value }] : findResources(value);
        if (resources.length) out.push({ id: `ui/global/${name}`, kind: "global", label: name, detail: "global", value, resources });
      }
      return out;
    }

    // All mounted component instances, walking the vnode tree from the root.
    components() {
      const out = [];
      const visit = (vnode) => {
        if (!vnode || out.length > MAX_COMPONENTS) return;
        if (vnode.component) {
          out.push(vnode.component);
          visit(vnode.component.subTree);
        } else if (vnode.suspense) {
          visit(vnode.suspense.activeBranch);
        } else if (Array.isArray(vnode.children)) {
          vnode.children.forEach(visit);
        }
      };
      if (this.app._instance) {
        out.push(this.app._instance);
        visit(this.app._instance.subTree);
      }
      return out;
    }

    resolveLive(id) {
      const owner = this.owners().find((o) => id === o.id || id.startsWith(`${o.id}/`));
      if (!owner) return null;
      if (id === owner.id) return { kind: "owner", owner };
      const key = decodeURIComponent(id.slice(owner.id.length + 1));
      const found = owner.resources.find((r) => r.key === key);
      return found ? { kind: "resource", owner, key, resource: found.resource } : null;
    }
  }

  // A frappe-ui resource of any flavor: createResource, createListResource, createDocumentResource,
  // useCall, useList or useDoc. All of them have reload(), loading, and data or doc.
  // Also an app's own document resource with load() instead of reload() (Insights 3 useDocumentResource).
  function isResource(value) {
    if (!value || typeof value !== "object" || value.$id) return false;
    if (!("loading" in value)) return false;
    if (typeof safeGet(value, "reload") === "function") return "data" in value || "doc" in value;
    return typeof safeGet(value, "load") === "function" && "doc" in value && "doctype" in value;
  }

  function resourceType(r) {
    if (typeof safeGet(r, "reload") !== "function") return "app resource (load)";
    if ("isFetching" in r) {
      if ("doc" in r) return "useDoc";
      if ("hasNextPage" in r) return "useList";
      return "useCall";
    }
    if ("doc" in r) return "createDocumentResource";
    if ("list" in r && "doctype" in r) return "createListResource";
    return "createResource";
  }

  function findResources(holder, prefix = "") {
    if (!holder || typeof holder !== "object") return [];
    const out = [];
    for (const key of Object.keys(holder)) {
      if (key.startsWith("$") || key.startsWith("_")) continue;
      const value = safeGet(holder, key);
      if (isResource(value)) out.push({ key: prefix + key, resource: value });
    }
    return out;
  }

  function resourceNode(id, key, r) {
    const target = r.url || (r.doctype ? `${r.doctype}${r.name ? ` ${r.name}` : ""}` : "");
    const flags = [];
    if (r.loading) flags.push("loading");
    if (r.error) flags.push("error");
    if (!r.loading && !r.error && (r.fetched === false || r.isFinished === false)) flags.push("not-fetched");
    return node(id, key, "resource", { detail: [resourceType(r), target].filter(Boolean).join(" · "), flags });
  }

  function componentName(vm) {
    const type = vm.type || {};
    const file = type.__file ? type.__file.split("/").pop().replace(/\.vue$/, "") : "";
    return type.name || type.__name || file || "Anonymous";
  }

  // Some getters throw when the object is not ready.
  function safeGet(obj, key) {
    try {
      return obj[key];
    } catch (_) {
      return undefined;
    }
  }

  function node(id, label, kind, extra = {}) {
    return { id, label, kind, detail: "", flags: [], ...extra };
  }

  NS.UiTree = UiTree;
  NS.ui = { isResource, resourceType, componentName };
})();
