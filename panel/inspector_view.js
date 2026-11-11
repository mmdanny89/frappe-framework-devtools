// Right side of the Tree, Timeline and Calls tabs: shows the sections of the selected item.

// What the right side says while nothing is selected, per tab.
const EMPTY_TEXT = {
  tree: "Select a node in the tree, or use the picker to choose a field on the page.",
  timeline: "Select an event to see its data and the JS stack that caused it.",
  calls: "Select a call to see its arguments, its response and the server traceback.",
};

class InspectorView {
  // onAction(name) runs when the user clicks an action button (for example Reload).
  // emptyText is shown, with the Frappe mark, while nothing is selected.
  constructor(container, { onAction, emptyText } = {}) {
    this.container = container;
    this.onAction = onAction;
    this.emptyText = emptyText;
    // Remembers which sections the user opened or closed, to keep them after a refresh.
    this.openState = new Map();
    if (emptyText) this.empty();
  }

  // data: "inspect" answer from the agent. node: tree node (label and kind).
  render(data, node) {
    if (data.missing) return this.empty("This node no longer exists on the page.");
    const head = el("div", "inspector-head");
    head.appendChild(el("h2", null, node?.label || data.id));
    if (node?.detail) head.appendChild(el("span", "detail", node.detail));

    const parts = [head];
    if (data.facts?.length) parts.push(factSheet(data.facts));
    if (data.actions?.length) parts.push(this.actionBar(data.actions));
    if (data.consoleVars?.length) parts.push(this.consoleHint(data.consoleVars));
    for (const section of data.sections) parts.push(this.section(section));
    this.container.replaceChildren(...parts);
  }

  empty(text = this.emptyText) {
    this.container.replaceChildren(emptyState(text));
  }

  // An action with `confirm` needs a second click within 5 seconds. The first click shows why.
  actionBar(actions) {
    const bar = el("div", "actions");
    for (const { name, label, confirm } of actions) {
      const button = bar.appendChild(el("button", null, label));
      let armed = false;
      button.addEventListener("click", () => {
        if (!confirm) return this.onAction?.(name, false);
        if (armed) return this.onAction?.(name, true);
        armed = true;
        button.textContent = "Click again to confirm";
        bar.appendChild(el("span", "confirm-note", confirm));
        setTimeout(() => {
          armed = false;
          button.textContent = label;
          bar.querySelector(".confirm-note")?.remove();
        }, 5000);
      });
    }
    return bar;
  }

  consoleHint(names) {
    const hint = el("p", "console-hint", "In the console: ");
    names.forEach((name, i) => {
      if (i) hint.append(", ");
      hint.appendChild(el("code", null, name));
    });
    return hint;
  }

  // Each section has `value` (JSON), `table` (list of rows) or `text` (plain text, for example a traceback).
  section({ title, value, table, text, open }) {
    const details = el("details", "section");
    details.open = this.openState.get(title) ?? open;
    details.addEventListener("toggle", () => this.openState.set(title, details.open));
    const summary = details.appendChild(el("summary"));
    summary.append(
      icon("chevron-right", { className: "chevron" }),
      icon(sectionIcon(title), { className: "section-icon" }),
      el("span", "section-title", title)
    );
    summary.appendChild(copyButton(() => (text !== undefined ? text : JSON.stringify(table ?? value, null, 2))));
    const body = details.appendChild(el("div", "section-body"));
    body.appendChild(sectionContent({ value, table, text }));
    return details;
  }
}

function sectionContent({ value, table, text }) {
  if (table) return TableView.render(table);
  if (text !== undefined) return el("pre", "text", text);
  return JsonView.render(value);
}

// Copies the section data. The click must not open or close the section.
function copyButton(getText) {
  const button = el("button", "copy-btn");
  button.title = "Copy";
  button.setAttribute("aria-label", "Copy");
  button.appendChild(icon("copy"));
  button.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyText(getText());
    button.replaceChildren(icon(ok ? "check" : "circle-alert"));
    button.classList.toggle("done", ok);
    setTimeout(() => {
      button.replaceChildren(icon("copy"));
      button.classList.remove("done");
    }, 1500);
  });
  return button;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // Older fallback for when the Clipboard API is not allowed in this context.
    const area = document.body.appendChild(el("textarea"));
    area.value = text;
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

// A short list of key facts with an icon each (Info tab summary).
function factSheet(facts) {
  const sheet = el("dl", "facts");
  for (const { iconName, label, value } of facts) {
    const term = sheet.appendChild(el("dt"));
    term.append(icon(iconName), label);
    sheet.appendChild(el("dd", null, value));
  }
  return sheet;
}

// The Frappe "F" (icons/frappe-f.svg, unchanged) is used as a CSS mask, so it takes the
// text color of the current DevTools theme. The animation lives in panel.css.
function emptyState(text) {
  const box = el("div", "empty-state");
  const mark = box.appendChild(el("span", "frappe-mark"));
  mark.setAttribute("aria-hidden", "true");
  box.appendChild(el("p", null, text));
  return box;
}
