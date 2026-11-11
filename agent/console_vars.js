// Console variables ($frm, $resource…), like $vm0 in Vue DevTools.
// A name is written only if the page does not use it already, so app globals are never overwritten.
// Names that do not apply to the selected node are deleted, not set to undefined.

(() => {
  const NS = (window.FrappeDevtools ??= {});

  const owned = new Set(); // names this extension created

  // vars: { name: value | undefined }. Returns the names that now hold a value.
  NS.setConsoleVars = function (vars) {
    const set = [];
    for (const [name, value] of Object.entries(vars)) {
      const free = owned.has(name) || !(name in window);
      if (!free) continue;
      if (value === undefined) {
        delete window[name];
        owned.delete(name);
      } else {
        window[name] = value;
        owned.add(name);
        set.push(name);
      }
    }
    return set;
  };
})();
