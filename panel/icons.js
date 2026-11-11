// Icons for the panel and the popup: Lucide symbols copied unchanged from Frappe's own sprite
// (icons/lucide.svg), the same set Frappe Desk and frappe-ui use.

const SPRITE = "/icons/lucide.svg";

// Returns an inline <svg> that shows one symbol of the sprite. `title` becomes the tooltip.
function icon(name, { title, className = "" } = {}) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", `icon ${className}`.trim());
  svg.setAttribute("aria-hidden", title ? "false" : "true");
  if (title) {
    const t = document.createElementNS(ns, "title");
    t.textContent = title;
    svg.appendChild(t);
  }
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", `${SPRITE}#icon-${name}`);
  svg.appendChild(use);
  return svg;
}

const KIND_ICONS = {
  route: "route",
  form: "file-text",
  tab: "panel-top",
  section: "rows-3",
  field: "text-cursor-input",
  row: "list",
  list: "list",
  dialog: "app-window",
  meta: "database",
  "meta-cache": "layers",
  live: "zap",
  component: "component",
  store: "box",
  global: "globe",
  resource: "cloud",
  requests: "send",
  request: "send",
};

// One icon per Frappe fieldtype, so the type of a field reads at a glance in the tree.
const FIELDTYPE_ICONS = {
  Data: "type",
  "Small Text": "text-align-start",
  Text: "text-align-start",
  "Long Text": "text-align-start",
  "Text Editor": "notebook-text",
  "Markdown Editor": "notebook-text",
  "HTML Editor": "file-code",
  HTML: "file-code",
  Code: "code-xml",
  JSON: "code-xml",
  Link: "link",
  "Dynamic Link": "link",
  Select: "list",
  Autocomplete: "list-filter",
  Check: "square-check",
  Int: "hash",
  Float: "hash",
  Currency: "banknote",
  Percent: "percent",
  Date: "calendar",
  Datetime: "calendar-clock",
  Time: "clock",
  Duration: "clock",
  Table: "table",
  "Table MultiSelect": "table",
  Attach: "paperclip",
  "Attach Image": "image",
  Image: "image",
  Signature: "signature",
  Color: "palette",
  Rating: "star",
  Password: "key-round",
  Geolocation: "map-pin",
  Barcode: "barcode",
  Button: "square-function",
  Phone: "phone",
  Icon: "shapes",
  Heading: "text-initial",
  "Read Only": "eye",
};

const FLAG_ICONS = {
  hidden: "eye-off",
  readonly: "lock",
  reqd: "asterisk",
  new: "sparkles",
  dirty: "pencil",
  submitted: "circle-check",
  cancelled: "circle-x",
  child: "table",
  single: "file",
  custom: "shapes",
  loading: "loader",
  error: "circle-alert",
  "not-fetched": "circle-dashed",
};

const CATEGORY_ICONS = {
  route: "route",
  form: "file-text",
  field: "pencil",
  call: "arrow-left-right",
  dialog: "app-window",
  msg: "message-square",
  realtime: "radio",
};

// Section titles come from the agent. The first pattern that matches gives the icon.
const SECTION_ICONS = [
  [/traceback/i, "bug"],
  [/stack/i, "footprints"],
  [/^why/i, "search"],
  [/^value$/i, "type"],
  [/docfield|\(df\)/i, "settings-2"],
  [/^control/i, "sliders-horizontal"],
  [/history/i, "history"],
  [/route/i, "route"],
  [/permission|role/i, "shield"],
  [/^fields|table|queried/i, "table"],
  [/event/i, "zap"],
  [/owner/i, "user"],
  [/docinfo|^info/i, "info"],
  [/message/i, "message-square"],
  [/response/i, "inbox"],
  [/param|args|request|list options/i, "sliders-horizontal"],
  [/propert|boot|config|global|sysdefaults/i, "settings-2"],
  [/version/i, "layers"],
  [/site|session|frappe-ui app/i, "globe"],
  [/state|summary|status/i, "activity"],
  [/data|document|row|values|doctypes/i, "database"],
];

const INFO_ICONS = {
  site: "globe",
  user: "user",
  language: "languages",
  time_zone: "clock",
  developer_mode: "code",
  vue: "component",
  router: "route",
  pinia_stores: "box",
  frappe_ui_config: "settings-2",
};

function sectionIcon(title) {
  const found = SECTION_ICONS.find(([pattern]) => pattern.test(title));
  return found ? found[1] : "braces";
}
