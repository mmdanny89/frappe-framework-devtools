// Turns any page value into plain data that can be sent to the panel.
// Frappe objects (frm, controls) hold circular references, DOM nodes and jQuery.

(() => {
  const NS = (window.FrappeDevtools ??= {});

  class Serializer {
    constructor({ maxDepth = 4, maxKeys = 300, maxItems = 200 } = {}) {
      this.maxDepth = maxDepth;
      this.maxKeys = maxKeys;
      this.maxItems = maxItems;
    }

    // Never throws: a revoked Proxy or a hostile getter becomes a text marker.
    serialize(value) {
      this.path = new WeakSet();
      try {
        return this.walk(value, 0);
      } catch (e) {
        return `[unserializable: ${e.message}]`;
      }
    }

    walk(value, depth) {
      if (value === undefined) return null; // JSON has no undefined; a quoted "undefined" would look like text
      if (value === null) return null;
      const type = typeof value;
      if (type === "number") return Number.isFinite(value) ? value : String(value);
      if (type === "string" || type === "boolean") return value;
      if (type === "bigint") return `${value}n`;
      if (type === "function") return `ƒ ${value.name || "anonymous"}()`;
      if (type === "symbol") return value.toString();
      return this.walkObject(value, depth);
    }

    walkObject(value, depth) {
      if (isDate(value)) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
      if (value instanceof Node) return describeNode(value);
      if (value.jquery) return `jQuery(${value.length})`;
      if (this.path.has(value)) return "[Circular]";
      if (depth >= this.maxDepth) return Array.isArray(value) ? `[… ${value.length}]` : "{…}";

      this.path.add(value);
      const out = Array.isArray(value) ? this.walkArray(value, depth) : this.walkPlain(value, depth);
      // A value is circular only if it appears inside itself. Shared references are shown.
      this.path.delete(value);
      return out;
    }

    walkArray(arr, depth) {
      const out = arr.slice(0, this.maxItems).map((v) => this.walk(v, depth + 1));
      if (arr.length > this.maxItems) out.push(`… ${arr.length - this.maxItems} more`);
      return out;
    }

    walkPlain(obj, depth) {
      const out = {};
      const className = obj.constructor?.name;
      if (className && className !== "Object") out.__class = className;

      const keys = Object.keys(obj);
      for (const key of keys.slice(0, this.maxKeys)) {
        const value = safeGet(obj, key);
        // Keys without a value only add noise to the inspector.
        if (value !== undefined) out[key] = this.walk(value, depth + 1);
      }
      if (keys.length > this.maxKeys) out["…"] = `${keys.length - this.maxKeys} more keys`;
      return out;
    }
  }

  function isDate(value) {
    try {
      return value instanceof Date;
    } catch (_) {
      return false;
    }
  }

  function describeNode(node) {
    if (!(node instanceof Element)) return `#${node.nodeName.toLowerCase()}`;
    const id = node.id ? `#${node.id}` : "";
    const cls = node.classList.length ? `.${[...node.classList].slice(0, 3).join(".")}` : "";
    return `<${node.tagName.toLowerCase()}${id}${cls}>`;
  }

  // Some Frappe getters throw when the object is not ready.
  function safeGet(obj, key) {
    try {
      return obj[key];
    } catch (e) {
      return `[error: ${e.message}]`;
    }
  }

  NS.Serializer = Serializer;
})();
