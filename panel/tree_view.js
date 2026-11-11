// Tree of nodes sent by the agent: route, form, list, dialogs and meta.

const KIND_LABELS = {
  route: "Route",
  form: "Form",
  tab: "Tab",
  section: "Section",
  row: "Row",
  list: "List",
  dialog: "Dialog",
  meta: "Meta",
  "meta-cache": "Meta",
  live: "Live",
  component: "Component",
  store: "Store",
  global: "Global",
  resource: "Resource",
  requests: "Requests",
  request: "Request",
};

const FLAG_LABELS = {
  hidden: "hidden",
  readonly: "read only",
  reqd: "mandatory",
  new: "new",
  dirty: "not saved",
  submitted: "submitted",
  cancelled: "cancelled",
  child: "child table",
  single: "single",
  custom: "custom",
  loading: "loading",
  error: "error",
  "not-fetched": "not fetched",
};

// Node kinds that start open the first time they appear.
const OPEN_BY_DEFAULT = new Set(["form", "tab", "dialog", "live", "component", "store", "global"]);

class TreeView {
  // onSelect(id) on click. onHover(id | null) on mouse over.
  constructor(container, { onSelect, onHover }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.nodes = [];
    this.byId = new Map();
    this.parentOf = new Map();
    this.expanded = new Set();
    this.known = new Set();
    this.filter = "";
    this.selectedId = null;
    container.addEventListener("mouseleave", () => this.onHover(null));
  }

  render(nodes) {
    this.nodes = nodes;
    this.index(nodes, null);
    this.draw();
  }

  select(id) {
    this.selectedId = id;
    for (let p = this.parentOf.get(id); p; p = this.parentOf.get(p)) this.expanded.add(p);
    this.draw();
    this.container.querySelector(".tree-row.selected")?.scrollIntoView({ block: "nearest" });
  }

  setFilter(text) {
    this.filter = text.trim().toLowerCase();
    this.draw();
  }

  nodeById(id) {
    return this.byId.get(id);
  }

  draw() {
    const fragment = document.createDocumentFragment();
    for (const node of this.nodes) this.drawNode(node, 0, fragment);
    this.container.replaceChildren(fragment);
  }

  drawNode(node, depth, out) {
    if (this.filter && !this.matches(node)) return;
    out.appendChild(this.row(node, depth));
    // With a filter, everything opens to show where each match is.
    if (this.filter || this.expanded.has(node.id)) {
      for (const child of node.children || []) this.drawNode(child, depth + 1, out);
    }
  }

  row(node, depth) {
    const row = el("div", "tree-row");
    row.setAttribute("role", "treeitem");
    row.style.paddingLeft = `${4 + depth * 14}px`;
    if (node.id === this.selectedId) row.classList.add("selected");

    const hasChildren = Boolean(node.children?.length);
    const open = this.filter || this.expanded.has(node.id);
    // Fixed-width lanes for the caret and the kind icon keep every row aligned.
    const caret = row.appendChild(el("span", "caret"));
    if (hasChildren) {
      caret.appendChild(icon("chevron-right", { className: open ? "open" : "" }));
      caret.addEventListener("click", (e) => this.toggle(e, node.id));
    }
    const kind = row.appendChild(el("span", `kind kind-${node.kind}`));
    const kindName = node.fieldtype || KIND_LABELS[node.kind] || "Field";
    kind.appendChild(icon(FIELDTYPE_ICONS[node.fieldtype] || KIND_ICONS[node.kind] || "circle-dot", { title: kindName }));

    row.appendChild(el("span", "label", node.label));
    if (node.detail) row.appendChild(el("span", "detail", node.detail));
    for (const flag of node.flags || []) row.appendChild(flagPill(flag));

    row.addEventListener("click", () => this.onSelect(node.id));
    row.addEventListener("dblclick", (e) => hasChildren && this.toggle(e, node.id));
    row.addEventListener("mouseenter", () => this.onHover(node.id));
    return row;
  }

  toggle(event, id) {
    event.stopPropagation();
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    this.draw();
  }

  matches(node) {
    const text = `${node.label} ${node.detail}`.toLowerCase();
    return text.includes(this.filter) || (node.children || []).some((c) => this.matches(c));
  }

  // Stores parents and ids, and opens new nodes of some kinds by default.
  index(nodes, parentId) {
    if (parentId === null) {
      this.byId.clear();
      this.parentOf.clear();
    }
    for (const node of nodes) {
      this.byId.set(node.id, node);
      if (parentId) this.parentOf.set(node.id, parentId);
      if (!this.known.has(node.id)) {
        this.known.add(node.id);
        if (OPEN_BY_DEFAULT.has(node.kind)) this.expanded.add(node.id);
      }
      this.index(node.children || [], node.id);
    }
  }
}

function flagPill(flag) {
  const pill = el("span", `flag flag-${flag}`);
  if (FLAG_ICONS[flag]) pill.appendChild(icon(FLAG_ICONS[flag]));
  pill.append(FLAG_LABELS[flag] || flag);
  return pill;
}
