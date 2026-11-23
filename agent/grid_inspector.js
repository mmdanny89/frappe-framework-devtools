// Inspector sections for child tables: the grid of a Table field, a row and a cell.
// Read only: it reads the Frappe Grid and GridRow objects and changes nothing.

(() => {
  const NS = (window.FrappeDevtools ??= {});

  class GridInspector {
    // Sections for a Table field, after its value.
    gridSections(grid) {
      const sections = [
        { title: "Grid", value: this.gridState(grid), open: true },
        { title: `Grid columns (${grid.visible_columns?.length || 0})`, table: this.columns(grid), open: true },
      ];
      if (Object.keys(grid.column_disp_overrides || {}).length) {
        sections.push({ title: "Column overrides (set_column_disp_in_list_view)", value: { ...grid.column_disp_overrides } });
      }
      return sections;
    }

    gridState(grid) {
      const pages = grid.grid_pagination;
      return {
        child_doctype: grid.doctype,
        display_status: grid.display_status,
        editable: Boolean(grid.is_editable?.()),
        editable_grid: Boolean(grid.meta?.editable_grid),
        sortable: Boolean(grid.is_sortable?.()),
        static_rows: Boolean(grid.static_rows),
        cannot_add_rows: Boolean(grid.cannot_add_rows || grid.df?.cannot_add_rows),
        cannot_delete_rows: Boolean(grid.df?.cannot_delete_rows),
        rows: grid.data?.length ?? 0,
        selected_rows: grid.get_selected?.() || [],
        filter: grid.filter || {},
        page: pages ? { page: pages.page_index, of: pages.total_pages, page_length: pages.page_length } : null,
        row_form_open: openRowForm(grid)?.doc?.name || null,
        inline_editing: editableRow(grid)?.doc?.name || null,
        columns_from: columnsSource(grid),
        set_query_on: Object.keys(grid.fieldinfo || {}).filter((f) => grid.fieldinfo[f]?.get_query),
      };
    }

    // The columns the grid shows, in order, with the width Frappe computed.
    columns(grid) {
      return (grid.visible_columns || []).map(([df, width]) => ({
        fieldname: df.fieldname,
        label: df.label,
        fieldtype: df.fieldtype,
        width,
        sticky: df.sticky ? 1 : "",
        reqd: df.reqd ? 1 : "",
      }));
    }

    rowState({ grid, gridRow, row }) {
      const pageLength = grid?.grid_pagination?.page_length;
      return {
        idx: row.idx,
        name: row.name,
        // Rows on another page of the grid are not drawn yet.
        drawn: Boolean(gridRow),
        page: pageLength ? Math.ceil(row.idx / pageLength) : null,
        selected: Boolean(row.__checked),
        row_form_open: Boolean(gridRow && openRowForm(grid) === gridRow),
        inline_editing: Boolean(gridRow && editableRow(grid) === gridRow),
      };
    }

    cellState({ grid, gridRow, df, control }) {
      return {
        grid_column: (grid?.visible_columns || []).some(([c]) => c.fieldname === df.fieldname),
        edited_in: !control ? null : gridRow?.on_grid_fields_dict?.[df.fieldname] === control ? "grid row" : "row form",
        grid_display_status: grid?.display_status,
      };
    }

    // The grid cell, or the field of the open row form.
    cellElement({ gridRow, df, control }) {
      if (control?.$wrapper?.is(":visible")) return control.$wrapper[0];
      return gridRow?.columns?.[df.fieldname]?.[0] || gridRow?.wrapper?.[0];
    }
  }

  // The open row form is in the DOM as .grid-row-open, one for the whole page.
  function openRowForm(grid) {
    const open = frappe.ui.form.get_open_grid_form?.();
    return open?.grid === grid ? open : null;
  }

  function editableRow(grid) {
    const row = frappe.ui.form.editable_row;
    return row?.grid === grid ? row : null;
  }

  // Same order as Grid.setup_visible_columns().
  function columnsSource(grid) {
    if (grid.user_defined_columns?.length) return "user settings (GridView)";
    if (grid.editable_fields) return "editable_fields";
    return "in_list_view";
  }

  NS.GridInspector = GridInspector;
})();
