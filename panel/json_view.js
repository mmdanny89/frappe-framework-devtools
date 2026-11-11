// Collapsible JSON viewer and table viewer. All text goes in with textContent,
// because the data comes from the page and is not trusted.

class JsonView {
  // openDepth: levels that start open.
  static render(value, { openDepth = 1 } = {}) {
    const root = el("div", "json");
    root.appendChild(JsonView.node(null, value, 0, openDepth));
    return root;
  }

  static node(key, value, depth, openDepth) {
    if (value === null || typeof value !== "object") return JsonView.leaf(key, value);

    const details = el("details");
    const summary = el("summary");
    if (key !== null) summary.append(el("span", "key", key), ": ");
    summary.append(icon(Array.isArray(value) ? "brackets" : "braces", { className: "type-icon" }), el("span", "preview", preview(value)));
    details.appendChild(summary);

    // Children are built when the node opens, so large objects do not block the panel.
    const fill = () => {
      if (details.dataset.filled) return;
      details.dataset.filled = "1";
      const children = el("div", "children");
      for (const [k, v] of Object.entries(value)) children.appendChild(JsonView.node(k, v, depth + 1, openDepth));
      details.appendChild(children);
    };
    details.addEventListener("toggle", () => details.open && fill());
    if (depth < openDepth) {
      details.open = true;
      fill();
    }
    return details;
  }

  static leaf(key, value) {
    const row = el("div", "leaf");
    if (key !== null) row.append(el("span", "key", key), ": ");
    row.appendChild(primitive(value));
    return row;
  }
}

class TableView {
  // rows: list of plain objects. The columns come from the keys of the first row.
  static render(rows) {
    const wrap = el("div");
    const filter = el("input", "table-filter");
    filter.type = "search";
    filter.placeholder = "Filter rows";
    const table = el("table");
    const columns = Object.keys(rows[0] || {});
    const head = el("tr");
    columns.forEach((c) => head.appendChild(el("th", null, c)));
    table.appendChild(el("thead")).appendChild(head);
    const body = table.appendChild(el("tbody"));

    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      body.replaceChildren();
      for (const row of rows) {
        const cells = columns.map((c) => String(row[c] ?? ""));
        if (q && !cells.some((v) => v.toLowerCase().includes(q))) continue;
        const tr = el("tr");
        cells.forEach((v) => tr.appendChild(el("td", null, v)));
        body.appendChild(tr);
      }
    };
    filter.addEventListener("input", draw);
    draw();
    wrap.append(filter, table);
    return wrap;
  }
}

function preview(value) {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  const keys = Object.keys(value).filter((k) => k !== "__class");
  const count = `${keys.length} key${keys.length === 1 ? "" : "s"}`;
  return value.__class ? `${value.__class} · ${count}` : count;
}

function primitive(value) {
  if (value === null) return el("span", "null", "null");
  if (typeof value === "string") return el("span", "str", JSON.stringify(value));
  if (typeof value === "number") return el("span", "num", String(value));
  if (typeof value === "boolean") return el("span", "bool", String(value));
  return el("span", null, String(value));
}

// Creates an element with an optional class and text.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
