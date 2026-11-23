// Form tools of Desk mode, switched on from the panel toolbar:
//   reveal: shows the fields, sections and tabs that Frappe hides (df.hidden or depends_on).
//   mark:   outlines the custom fields and the hidden fields of the form on the page.
// Both are global: they follow the user to every form they open, until they are switched off
// or the DevTools panel closes. Nothing is saved, and switching off restores the form.

(() => {
  const NS = (window.FrappeDevtools ??= {});

  class FormTools {
    constructor() {
      this.revealer = new Revealer();
      this.marker = new Marker();
      this.on = { reveal: false, mark: false };
    }

    state() {
      return { ...this.on };
    }

    // The agent calls sync() right after, with the form on screen.
    set(tool, on) {
      if (!(tool in this.on)) return;
      this.on[tool] = Boolean(on);
      if (tool === "reveal" && !on) this.revealer.restoreAll();
    }

    // Applies the tools to the form on screen. The agent calls it before each tree update.
    sync(frm) {
      if (this.on.reveal && frm) this.revealer.reveal(frm);
      if (this.on.mark && frm) this.marker.update(frm);
      else this.marker.remove();
    }

    stop() {
      this.set("reveal", false);
      this.set("mark", false);
      this.marker.remove();
    }

    isRevealed(control) {
      return this.revealer.controls.has(control);
    }
  }

  // Frappe decides visibility in control.get_status() and in section.refresh() / tab.refresh(),
  // from df.hidden and df.hidden_due_to_dependency. The revealer wraps those methods on each
  // instance and runs them with both flags at 0, then puts the flags back. So the df keeps its
  // real values: the tree, the inspector and depends_on still see the field as hidden.
  // Fields hidden by permissions (permlevel without read) stay hidden.
  class Revealer {
    constructor() {
      this.layouts = new Map(); // frm -> layout it was revealed on
      this.controls = new WeakSet();
    }

    reveal(frm) {
      // Frappe builds a new layout when the meta changes (for example after Customize Form).
      if (this.layouts.get(frm) === frm.layout) return;
      const { fields_list = [], sections = [], tabs = [] } = frm.layout;
      for (const control of fields_list) {
        // A df.get_status of its own (the __newname field of new documents) wins over get_status().
        if (control.df?.get_status) continue;
        wrapIgnoringHidden(control, "get_status");
        this.controls.add(control);
      }
      for (const part of [...sections, ...tabs]) wrapIgnoringHidden(part, "refresh");
      this.layouts.set(frm, frm.layout);
      frm.refresh_fields();
    }

    restoreAll() {
      for (const [frm, layout] of this.layouts) {
        const { fields_list = [], sections = [], tabs = [] } = layout;
        for (const control of fields_list) {
          unwrap(control, "get_status");
          this.controls.delete(control);
        }
        for (const part of [...sections, ...tabs]) unwrap(part, "refresh");
        if (frm.layout === layout) frm.refresh_fields();
      }
      this.layouts.clear();
    }
  }

  // One <style> element, scoped to the form page. CSS outlines do not change the layout,
  // and removing the element removes every mark.
  class Marker {
    update(frm) {
      const css = this.css(frm);
      if (this.style?.isConnected && this.style.textContent === css) return;
      if (!this.style?.isConnected) {
        this.style = document.createElement("style");
        this.style.dataset.frappeDevtools = "marks";
        document.head.appendChild(this.style);
      }
      this.style.textContent = css;
    }

    remove() {
      this.style?.remove();
      this.style = null;
    }

    css(frm) {
      const page = `#${CSS.escape(frm.wrapper?.id || "")}`;
      const rules = [];
      for (const control of frm.layout?.fields_list || []) {
        const tags = markTags(control.df);
        // Fields inside child table rows have the same data-fieldname: skip them.
        if (tags) rules.push(markRule(`${page} .frappe-control[data-fieldname="${CSS.escape(control.df.fieldname)}"]:not(.grid-row *)`, tags));
      }
      for (const section of frm.layout?.sections || []) {
        const tags = section.df && markTags(section.df);
        if (tags) rules.push(markRule(`${page} .form-section[data-fieldname="${CSS.escape(section.df.fieldname)}"]`, tags));
      }
      return rules.join("\n");
    }
  }

  const COLORS = { custom: "#8b2ab1", hidden: "#d97706" };

  function markTags(df) {
    const tags = [];
    if (df.is_custom_field) tags.push("custom");
    if (df.hidden || df.hidden_due_to_dependency) tags.push("hidden");
    return tags.length ? tags : null;
  }

  // Custom: solid outline. Hidden: dashed. Both: dashed in the custom color.
  // The tag in the corner says which one, also for color-blind users.
  function markRule(selector, tags) {
    const color = tags.includes("custom") ? COLORS.custom : COLORS.hidden;
    const style = tags.includes("hidden") ? "dashed" : "solid";
    return `${selector} { outline: 2px ${style} ${color} !important; outline-offset: 2px; position: relative; }
${selector}::after { content: "${tags.join(" · ")}"; position: absolute; top: -9px; right: 4px; z-index: 5;
  padding: 0 5px; border-radius: 3px; background: ${color}; color: #fff;
  font: 10px/15px monospace; pointer-events: none; }`;
  }

  // An own property shadows the prototype method. Deleting it brings the original back.
  function wrapIgnoringHidden(obj, name) {
    if (!obj || Object.hasOwn(obj, name)) return;
    const original = obj[name];
    obj[name] = function (...args) {
      return withoutHidden(this.df, () => original.apply(this, args));
    };
  }

  function unwrap(obj, name) {
    if (obj && Object.hasOwn(obj, name)) delete obj[name];
  }

  const HIDDEN_KEYS = ["hidden", "hidden_due_to_dependency"];

  // Puts each key back exactly as it was, also when it did not exist.
  function withoutHidden(df, fn) {
    if (!df) return fn();
    const saved = HIDDEN_KEYS.map((key) => [key, Object.hasOwn(df, key), df[key]]);
    for (const key of HIDDEN_KEYS) df[key] = 0;
    try {
      return fn();
    } finally {
      for (const [key, had, value] of saved) {
        if (had) df[key] = value;
        else delete df[key];
      }
    }
  }

  NS.FormTools = FormTools;
})();
