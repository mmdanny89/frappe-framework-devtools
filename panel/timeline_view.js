// Timeline tab: Desk events in order, newest first.

const TIMELINE_CATEGORIES = {
  route: "Route",
  form: "Form",
  field: "Field",
  call: "Call",
  dialog: "Dialog",
  msg: "Message",
  realtime: "Realtime",
};
const MAX_TIMELINE_ROWS = 2000;

class TimelineView {
  // onClear() tells the agent to clear its record too.
  constructor({ body, detail, filter, categories, pause, clear, onClear }) {
    this.body = body;
    this.detail = new InspectorView(detail, { emptyText: EMPTY_TEXT.timeline });
    this.filter = filter;
    this.pauseButton = pause;
    this.paused = false;
    this.onClear = onClear;
    this.hiddenCats = new Set();
    this.events = new Map(); // id -> event, to show the detail
    this.buildCategoryToggles(categories);
    filter.addEventListener("input", () => this.applyFilter());
    pause.addEventListener("click", () => this.togglePause());
    clear.addEventListener("click", () => this.clear());
  }

  // Replaces everything with the full record from the agent (when the panel connects).
  reset(events) {
    this.body.replaceChildren();
    this.events.clear();
    this.add(events, { force: true });
  }

  add(events, { force = false } = {}) {
    if (this.paused && !force) return;
    const fragment = document.createDocumentFragment();
    for (const event of events) {
      this.events.set(event.id, event);
      fragment.prepend(this.row(event));
    }
    this.body.prepend(fragment);
    this.trim();
  }

  row(event) {
    const tr = el("tr");
    tr.dataset.id = event.id;
    tr.dataset.cat = event.cat;
    tr.dataset.search = `${event.title} ${event.detail}`.toLowerCase();
    tr.className = `level-${event.level}`;
    tr.appendChild(el("td", "time", formatTime(event.t)));
    tr.appendChild(el("td")).appendChild(categoryChip(event.cat));
    tr.appendChild(el("td", "title", event.title));
    tr.appendChild(el("td", "detail", event.detail));
    tr.addEventListener("click", () => this.select(tr, event));
    this.matchRow(tr);
    return tr;
  }

  select(tr, event) {
    this.body.querySelector("tr.selected")?.classList.remove("selected");
    tr.classList.add("selected");
    // A traceback is easier to read as text than inside the JSON.
    const { traceback, ...data } = event.data || {};
    const sections = [];
    if (traceback) sections.push({ title: "Server traceback", text: traceback, open: true });
    sections.push({ title: "Data", value: data, open: true });
    if (event.stack) sections.push({ title: "JS stack (who caused it)", text: event.stack, open: true });
    this.detail.render(
      { sections },
      { label: event.title, detail: `${TIMELINE_CATEGORIES[event.cat]} · ${formatTime(event.t)}` }
    );
  }

  buildCategoryToggles(container) {
    for (const [cat, label] of Object.entries(TIMELINE_CATEGORIES)) {
      const toggle = el("label", `cat-toggle cat-${cat}`);
      const box = el("input");
      box.type = "checkbox";
      box.checked = true;
      box.addEventListener("change", () => {
        if (box.checked) this.hiddenCats.delete(cat);
        else this.hiddenCats.add(cat);
        this.applyFilter();
      });
      toggle.append(box, icon(CATEGORY_ICONS[cat]), label);
      container.appendChild(toggle);
    }
  }

  applyFilter() {
    for (const tr of this.body.rows) this.matchRow(tr);
  }

  matchRow(tr) {
    const q = this.filter.value.trim().toLowerCase();
    tr.hidden = this.hiddenCats.has(tr.dataset.cat) || (q && !tr.dataset.search.includes(q));
  }

  togglePause() {
    this.paused = !this.paused;
    this.pauseButton.replaceChildren(icon(this.paused ? "play" : "pause"), el("span", null, this.paused ? "Resume" : "Pause"));
    this.pauseButton.setAttribute("aria-pressed", String(this.paused));
  }

  clear() {
    this.body.replaceChildren();
    this.events.clear();
    this.detail.empty();
    this.onClear();
  }

  trim() {
    while (this.body.rows.length > MAX_TIMELINE_ROWS) {
      this.events.delete(Number(this.body.lastElementChild.dataset.id));
      this.body.lastElementChild.remove();
    }
  }
}

function formatTime(ms) {
  const d = new Date(ms);
  const pad = (n, size = 2) => String(n).padStart(size, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function categoryChip(cat) {
  const chip = el("span", `cat cat-${cat}`);
  if (CATEGORY_ICONS[cat]) chip.appendChild(icon(CATEGORY_ICONS[cat]));
  chip.append(TIMELINE_CATEGORIES[cat] || cat);
  return chip;
}
