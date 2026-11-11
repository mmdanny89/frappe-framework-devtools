// Prepares what the panel shows for a node, the DOM element to highlight
// and the console variables ($frm, $doc, $df…), like $vm0 in Vue DevTools.

(() => {
  const NS = (window.FrappeDevtools ??= {});

  class Inspector {
    constructor() {
      this.deep = new NS.Serializer({ maxDepth: 5 });
      // A control points to frm, the layout, etc. More depth makes the result huge.
      this.shallow = new NS.Serializer({ maxDepth: 2 });
    }

    // Returns { sections: [{ title, value | table, open }], consoleVars }.
    inspect(target) {
      const sections = this.sectionsFor(target).map((s) => this.serializeSection(s));
      const consoleVars = this.exposeToConsole(target);
      return { sections, consoleVars };
    }

    sectionsFor(t) {
      switch (t.kind) {
        case "route": return this.routeSections();
        case "form": return this.formSections(t.frm);
        case "tab":
        case "section": return [section("DocField", t.df, true)];
        case "field": return this.fieldSections(t);
        case "row": return this.rowSections(t);
        case "list": return this.listSections(t.list);
        case "dialog": return this.dialogSections(t.dialog);
        case "meta": return this.metaSections(t.meta);
        case "meta-cache": return [section("DocTypes", Object.keys(locals.DocType || {}).sort(), true)];
        default: return [];
      }
    }

    routeSections() {
      return [
        section("Route", { route: frappe.get_route(), route_options: frappe.route_options }, true),
        section("History (last 15)", frappe.route_history.slice(-15).reverse()),
      ];
    }

    formSections(frm) {
      const docinfo = frappe.model.docinfo?.[frm.doctype]?.[frm.docname];
      return [
        section("State", {
          doctype: frm.doctype,
          name: frm.docname,
          docstatus: frm.doc.docstatus,
          is_new: frm.is_new(),
          is_dirty: frm.is_dirty(),
          perm_level_0: frm.perm?.[0],
        }, true),
        section("Document (frm.doc)", frm.doc, true),
        section("Registered form events", frappe.ui.form.handlers[frm.doctype] || {}),
        section("Docinfo", docinfo || null),
      ];
    }

    fieldSections({ df, control, frm, dialog }) {
      const doc = frm?.doc || dialog?.doc;
      return [
        section("Value", control ? control.get_value() : doc?.[df.fieldname], true),
        section("Why does it look like this?", {
          disp_status: control?.disp_status ?? "no control",
          reasons: explain(df, control, frm?.doc),
        }, true),
        section("DocField (df)", df, true),
        { title: "Control", value: control, shallow: true },
      ];
    }

    rowSections({ row, df }) {
      return [
        section("Row", row, true),
        section(`Table: ${df.fieldname} → ${df.options}`, df),
      ];
    }

    listSections(list) {
      return [
        section("State", {
          doctype: list.doctype,
          view: list.view_name,
          filters: list.filter_area?.get(),
          sort_by: list.sort_by,
          sort_order: list.sort_order,
          start: list.start,
          page_length: list.page_length,
          rows_loaded: list.data?.length,
        }, true),
        section("Queried fields", list.fields),
        section("Data", list.data),
      ];
    }

    dialogSections(dialog) {
      return [
        section("Values", dialog.get_values(true), true),
        section("Fields (df)", dialog.fields),
      ];
    }

    metaSections(meta) {
      const fields = (meta.fields || []).map((df) => ({
        idx: df.idx,
        fieldname: df.fieldname,
        fieldtype: df.fieldtype,
        label: df.label,
        options: df.options,
        reqd: df.reqd ? 1 : "",
        hidden: df.hidden ? 1 : "",
      }));
      const { fields: _f, permissions, ...properties } = meta;
      return [
        { title: `Fields (${fields.length})`, table: fields, open: true },
        section("Properties", properties),
        section("Permissions", permissions || []),
      ];
    }

    serializeSection(s) {
      if (s.table) return s;
      const serializer = s.shallow ? this.shallow : this.deep;
      return { title: s.title, open: s.open, value: serializer.serialize(s.value) };
    }

    exposeToConsole(t) {
      const vars = {
        $frm: t.frm,
        $doc: t.row || t.frm?.doc || t.dialog?.doc,
        $df: t.df,
        $control: t.control,
        $meta: t.meta || t.frm?.meta,
        $list: t.list,
        $dialog: t.dialog,
      };
      return NS.setConsoleVars(vars);
    }

    // Data for the Info tab.
    info() {
      const boot = frappe.boot;
      const serializer = new NS.Serializer({ maxDepth: 4 });
      return {
        summary: {
          site: boot.sitename,
          user: frappe.session.user,
          language: boot.lang,
          time_zone: boot.time_zone?.system,
          developer_mode: boot.developer_mode,
        },
        sections: [
          { title: "App versions", value: boot.versions, open: true },
          { title: "User roles", value: frappe.user_roles },
          { title: "sysdefaults", value: serializer.serialize(boot.sysdefaults) },
          { title: "Full frappe.boot", value: serializer.serialize(boot) },
        ],
      };
    }

    // Extra fields of the "status" message (toolbar button and popup).
    statusInfo() {
      return { site: frappe.boot.sitename, user: frappe.session.user, version: `Frappe ${frappe.boot.versions?.frappe}` };
    }

    // Desk nodes have no actions.
    action() {
      return null;
    }

    // The page element for a node, to highlight it.
    element(t) {
      const layout = t.frm?.layout;
      const fieldname = t.df?.fieldname;
      switch (t.kind) {
        case "form": return layout?.wrapper?.[0];
        case "tab": return layout?.tabs.find((tab) => tab.df.fieldname === fieldname)?.tab_link?.[0];
        case "section": return layout?.sections.find((s) => s.df.fieldname === fieldname)?.wrapper?.[0];
        case "field": return t.control?.$wrapper?.[0];
        case "row": return t.control?.grid?.wrapper?.find(`.grid-row[data-name="${CSS.escape(t.row.name)}"]`)[0];
        case "list": return t.list.$result?.[0];
        case "dialog": return t.dialog.$wrapper?.find(".modal-content")[0];
        default: return null;
      }
    }
  }

  // Common reasons why a field is hidden, read-only or mandatory.
  function explain(df, control, doc) {
    const reasons = [];
    if (df.hidden) reasons.push("df.hidden = 1");
    if (df.hidden_due_to_dependency) reasons.push(`Hidden by depends_on: ${df.depends_on}`);
    if (df.read_only) reasons.push("df.read_only = 1");
    if (df.read_only_depends_on) reasons.push(`Has read_only_depends_on: ${df.read_only_depends_on}`);
    if (df.mandatory_depends_on) reasons.push(`Has mandatory_depends_on: ${df.mandatory_depends_on}`);
    if (df.permlevel) reasons.push(`permlevel ${df.permlevel}: depends on the role permissions at that level`);
    if (doc?.docstatus === 1 && !df.allow_on_submit) reasons.push("Document is submitted and the field has no allow_on_submit");
    if (doc?.docstatus === 2) reasons.push("Document is cancelled");
    if (control?.disp_status !== "None" && control?.$wrapper && !control.$wrapper.is(":visible")) {
      reasons.push("Visible, but in another tab or in a collapsed section");
    }
    return reasons;
  }

  function section(title, value, open = false) {
    return { title, value, open };
  }

  NS.Inspector = Inspector;
})();
