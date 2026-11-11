// Creates the "Frappe" tab in DevTools with the Frappe "F" icon.
// The panel is always created, because Firefox cannot remove it later. On a non-development site it stays inactive.
browser.devtools.panels.create("Frappe Framework", "/icons/frappe-f.svg", "/panel/panel.html");
