// Info tab: site and session data. The agent sends a summary plus sections,
// from frappe.boot on Desk or from the app (boot, frappe-ui config, Vue) on frappe-ui pages.
// The summary shows as a fact sheet. The sections keep the JSON viewer.

class InfoView {
  constructor(container) {
    this.inspector = new InspectorView(container);
  }

  render(info) {
    this.inspector.render(
      { facts: Object.entries(info.summary).map(([key, value]) => fact(key, value)), sections: info.sections },
      { label: info.summary.site, detail: info.mode === "ui" ? "frappe-ui app" : "Frappe Desk" }
    );
  }
}

function fact(key, value) {
  return { iconName: INFO_ICONS[key] || "circle-dot", label: humanize(key), value: formatFact(key, value) };
}

function humanize(key) {
  const text = key.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatFact(key, value) {
  if (key === "developer_mode") return value ? "On" : "Off";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}
