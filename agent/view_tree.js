// Builds the tree of what is on screen (the "component tree" of Frappe Desk)
// and resolves a node id to the real Frappe object.
//
// Node ids:
//   route
//   form, form/tab/<fieldname>, form/section/<fieldname>, form/field/<fieldname>
//   form/row/<table>/<row name>, form/row/<table>/<row name>/field/<fieldname> (a cell)
//   form/meta (meta of the form's DocType)
//   list
//   dialog/<i>, dialog/<i>/field/<fieldname>
//   meta, meta/<doctype> (every meta cached in locals.DocType)

(() => {
  const NS = (window.FrappeDevtools ??= {});

  const TABLE_TYPES = new Set(["Table", "Table MultiSelect"]);
  const LAYOUT_TYPES = new Set(["Tab Break", "Section Break", "Column Break"]);

  class ViewTree {
    constructor() {
      // Rows the panel expanded. Only these send their cells: a big table would send thousands.
      this.openRows = new Set();
    }

    setRowOpen(id, open) {
      if (open) this.openRows.add(id);
      else this.openRows.delete(id);
    }

    // The picker can choose a cell of a closed row: open the row so that the node exists.
    openPathTo(id) {
      const row = id.match(/^form\/row\/[^/]+\/[^/]+(?=\/field\/)/);
      if (row) this.openRows.add(row[0]);
    }

    build() {
      const nodes = [this.routeNode()];
      const frm = this.currentForm();
      if (frm) nodes.push(this.formNode(frm));
      const list = this.currentList();
      if (list) nodes.push(node("list", `List: ${list.doctype}`, "list", { detail: list.view_name }));
      this.dialogs().forEach((dialog, i) => nodes.push(this.dialogNode(dialog, i)));
      nodes.push(this.metaCacheNode());
      return nodes;
    }

    // Returns { kind, frm, dialog, control, df, row } for an id, or null if it no longer exists.
    resolve(id) {
      const parts = id.split("/");
      if (parts[0] === "route") return { kind: "route" };
      if (parts[0] === "list") return this.currentList() ? { kind: "list", list: this.currentList() } : null;
      if (parts[0] === "form") return this.resolveForm(parts);
      if (parts[0] === "dialog") return this.resolveDialog(parts);
      if (parts[0] === "meta") return this.resolveMeta(parts);
      return null;
    }

    // cur_frm keeps its value after leaving the form, so the route is checked too.
    currentForm() {
      const [view, doctype] = frappe.get_route() || [];
      const frm = window.cur_frm;
      return view === "Form" && frm?.doctype === doctype ? frm : null;
    }

    currentList() {
      const [view] = frappe.get_route() || [];
      return view === "List" ? window.cur_list : null;
    }

    dialogs() {
      return (frappe.ui.open_dialogs || []).filter((d) => d.display);
    }

    routeNode() {
      // v16 serves Desk at /desk (/app redirects). Use the real URL.
      return node("route", location.pathname, "route");
    }

    formNode(frm) {
      // One row form can be open in the whole page. Read it once, not once per row.
      this.openGridRow = frappe.ui.form.get_open_grid_form?.();
      const root = node("form", frm.docname, "form", {
        detail: frm.doctype,
        flags: formFlags(frm),
        children: [node("form/meta", "Meta", "meta", { detail: frm.doctype })],
      });
      let tab = null;
      let section = null;
      for (const df of frm.meta.fields) {
        if (df.fieldtype === "Tab Break") {
          tab = node(`form/tab/${df.fieldname}`, df.label || df.fieldname, "tab", { children: [] });
          root.children.push(tab);
          section = null;
        } else if (df.fieldtype === "Section Break") {
          section = node(`form/section/${df.fieldname}`, df.label || df.fieldname, "section", {
            children: [],
          });
          (tab || root).children.push(section);
        } else if (!LAYOUT_TYPES.has(df.fieldtype)) {
          (section || tab || root).children.push(this.formFieldNode(frm, df));
        }
      }
      return root;
    }

    formFieldNode(frm, df) {
      const control = frm.fields_dict[df.fieldname];
      const field = fieldNode(`form/field/${df.fieldname}`, df, control);
      if (TABLE_TYPES.has(df.fieldtype)) {
        field.children = (frm.doc[df.fieldname] || []).map((row) => this.rowNode(df, control, row));
      }
      return field;
    }

    // `lazy` tells the panel that the row has cells to ask for when it opens.
    rowNode(df, control, row) {
      const id = `form/row/${df.fieldname}/${row.name}`;
      const gridRow = control?.grid?.grid_rows_by_docname?.[row.name];
      const extra = { detail: row.name, flags: rowFlags(gridRow, row, this.openGridRow), lazy: true };
      if (this.openRows.has(id)) extra.children = this.cellNodes(id, df, control?.grid, gridRow);
      return node(id, `#${row.idx}`, "row", extra);
    }

    cellNodes(rowId, tableDf, grid, gridRow) {
      const inGrid = new Set((grid?.visible_columns || []).map(([df]) => df.fieldname));
      return rowDocfields(tableDf, gridRow).map((df) => {
        const cell = fieldNode(`${rowId}/field/${df.fieldname}`, df, cellControl(gridRow, df.fieldname));
        if (inGrid.has(df.fieldname)) cell.flags.push("in-grid");
        return cell;
      });
    }

    dialogNode(dialog, i) {
      const fields = (dialog.fields || []).filter((df) => df.fieldname && !LAYOUT_TYPES.has(df.fieldtype));
      return node(`dialog/${i}`, dialog.title || "Dialog", "dialog", {
        children: fields.map((df) =>
          fieldNode(`dialog/${i}/field/${df.fieldname}`, df, dialog.fields_dict[df.fieldname])
        ),
      });
    }

    // locals.DocType holds the meta of every DocType the client has loaded.
    metaCacheNode() {
      const doctypes = Object.keys(locals.DocType || {}).sort();
      return node("meta", "Cached meta", "meta-cache", {
        detail: `${doctypes.length} DocTypes`,
        children: doctypes.map((dt) => node(`meta/${dt}`, dt, "meta", { flags: metaFlags(dt) })),
      });
    }

    // Maps a DOM element to the most specific node id that contains it (element picker).
    locate(el) {
      const dialogIndex = this.dialogs().findIndex((d) => d.$wrapper?.[0]?.contains(el));
      if (dialogIndex >= 0) return dialogId(el, dialogIndex);
      return this.currentForm() ? formId(el) : null;
    }

    resolveForm(parts) {
      const frm = this.currentForm();
      if (!frm) return null;
      const [, kind, fieldname, rowName] = parts;
      if (!kind) return { kind: "form", frm };
      if (kind === "meta") return { kind: "meta", meta: frm.meta };
      const df = frappe.meta.get_docfield(frm.doctype, fieldname, frm.docname)
        || frm.meta.fields.find((f) => f.fieldname === fieldname);
      if (!df) return null;
      const control = frm.fields_dict[fieldname];
      if (kind === "row") {
        const row = (frm.doc[fieldname] || []).find((r) => r.name === rowName);
        if (!row) return null;
        const grid = control?.grid;
        const gridRow = grid?.grid_rows_by_docname?.[row.name];
        if (parts[4] === "field") return resolveCell({ frm, tableDf: df, grid, gridRow, row }, parts[5]);
        return { kind, frm, df, control, row, grid, gridRow };
      }
      return { kind, frm, df, control };
    }

    resolveMeta(parts) {
      const doctype = parts[1];
      if (!doctype) return { kind: "meta-cache" };
      const meta = locals.DocType?.[doctype];
      return meta ? { kind: "meta", meta } : null;
    }

    resolveDialog(parts) {
      const [, index, , fieldname] = parts;
      const dialog = this.dialogs()[Number(index)];
      if (!dialog) return null;
      if (!fieldname) return { kind: "dialog", dialog };
      const control = dialog.fields_dict[fieldname];
      return control ? { kind: "field", dialog, control, df: control.df } : null;
    }
  }

  function dialogId(el, index) {
    const control = el.closest(".frappe-control[data-fieldname]");
    return control ? `dialog/${index}/field/${control.dataset.fieldname}` : `dialog/${index}`;
  }

  // The cells of a table row also have data-fieldname, so check the row first.
  // A cell is a column of the grid row, or a field of the open row form.
  function formId(el) {
    const row = el.closest(".grid-row[data-name]");
    const table = row?.closest(".frappe-control[data-fieldname]");
    if (row && table) {
      const rowId = `form/row/${table.dataset.fieldname}/${row.dataset.name}`;
      const cell = el.closest(".grid-static-col[data-fieldname], .frappe-control[data-fieldname]");
      return cell && row.contains(cell) ? `${rowId}/field/${cell.dataset.fieldname}` : rowId;
    }

    const control = el.closest(".frappe-control[data-fieldname]");
    if (control) return `form/field/${control.dataset.fieldname}`;
    const section = el.closest(".form-section[data-fieldname]");
    if (section?.dataset.fieldname && section.dataset.fieldname !== "undefined") {
      return `form/section/${section.dataset.fieldname}`;
    }
    return "form";
  }

  function fieldNode(id, df, control) {
    return node(id, df.label || df.fieldname, "field", {
      fieldtype: df.fieldtype, // the panel picks the field icon from it
      detail: `${df.fieldname} · ${df.fieldtype}`,
      flags: fieldFlags(df, control),
    });
  }

  // Frappe computes disp_status on refresh: Write, Read or None (hidden).
  // control.df is the form's own copy of the docfield: set_df_property() and toggle_reqd() change it,
  // not the meta. So it wins over the meta docfield.
  // The df flags count too: with "Show hidden fields" on, a hidden field is on screen but still hidden.
  function fieldFlags(df, control) {
    const own = control?.df || df;
    const flags = [];
    if (control?.disp_status === "None" || own.hidden || own.hidden_due_to_dependency) flags.push("hidden");
    // A cell that is not being edited has no control: then df.read_only is all there is.
    if (control ? control.disp_status === "Read" : own.read_only) flags.push("readonly");
    if (own.reqd) flags.push("reqd");
    if (own.is_custom_field) flags.push("custom");
    return flags;
  }

  // The row's own docfield copies (depends_on of the row changes them). Rows on another page
  // of the grid have no GridRow yet: then the child meta.
  function rowDocfields(tableDf, gridRow) {
    const fields = gridRow?.docfields || frappe.get_meta(tableDf.options)?.fields || [];
    return fields.filter((df) => df.fieldname && !frappe.model.layout_fields.includes(df.fieldtype));
  }

  // A cell has a control only while it is edited: inline in the grid or in the row form.
  function cellControl(gridRow, fieldname) {
    return gridRow?.on_grid_fields_dict?.[fieldname] || gridRow?.grid_form?.fields_dict?.[fieldname];
  }

  function resolveCell({ frm, tableDf, grid, gridRow, row }, fieldname) {
    const df = rowDocfields(tableDf, gridRow).find((f) => f.fieldname === fieldname);
    if (!df) return null;
    return { kind: "cell", frm, df, control: cellControl(gridRow, fieldname), row, tableDf, grid, gridRow };
  }

  function rowFlags(gridRow, row, openGridRow) {
    const flags = [];
    if (gridRow && (gridRow === frappe.ui.form.editable_row || gridRow === openGridRow)) flags.push("editing");
    if (row.__checked) flags.push("checked");
    return flags;
  }

  function metaFlags(doctype) {
    const meta = locals.DocType[doctype];
    const flags = [];
    if (meta.istable) flags.push("child");
    if (meta.issingle) flags.push("single");
    if (meta.custom) flags.push("custom");
    return flags;
  }

  function formFlags(frm) {
    const flags = [];
    if (frm.is_new()) flags.push("new");
    if (frm.is_dirty()) flags.push("dirty");
    if (frm.doc.docstatus === 1) flags.push("submitted");
    if (frm.doc.docstatus === 2) flags.push("cancelled");
    return flags;
  }

  function node(id, label, kind, extra = {}) {
    return { id, label, kind, detail: "", flags: [], ...extra };
  }

  NS.ViewTree = ViewTree;
})();
