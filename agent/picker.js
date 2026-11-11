// "Select element" mode: hovering highlights a field, and a click selects it in the panel.

(() => {
  const NS = (window.FrappeDevtools ??= {});

  class Picker {
    // agent.view is the current view: { tree, inspector } for Desk or for frappe-ui.
    constructor(agent) {
      this.agent = agent;
      this.highlighter = agent.highlighter;
      this.handlers = {
        mousemove: (e) => this.onMove(e),
        click: (e) => this.onClick(e),
        keydown: (e) => this.onKey(e),
        visibilitychange: () => document.hidden && this.stop(true),
      };
      // While picking, none of these may reach the app (menus and popovers open on pointerdown).
      for (const type of BLOCKED_EVENTS) this.handlers[type] = (e) => block(e);
      this.active = false;
    }

    // onPick(id) gets the node id. onCancel() runs when the user presses Escape.
    start({ onPick, onCancel }) {
      if (this.active) this.stop();
      this.active = true;
      this.onPick = onPick;
      this.onCancel = onCancel;
      for (const [type, fn] of Object.entries(this.handlers)) window.addEventListener(type, fn, true);
      document.documentElement.style.cursor = "crosshair";
    }

    stop(cancelled = false) {
      if (!this.active) return;
      this.active = false;
      for (const [type, fn] of Object.entries(this.handlers)) window.removeEventListener(type, fn, true);
      document.documentElement.style.cursor = "";
      this.highlighter.hide();
      if (cancelled) this.onCancel?.();
    }

    onMove(e) {
      const { tree, inspector } = this.agent.view;
      const id = this.idFromElement(e.target);
      const target = id && tree.resolve(id);
      this.highlighter.show(target && inspector.element(target), id);
    }

    // Esc cancels the pick and must not also close the app's dialog.
    onKey(e) {
      if (e.key !== "Escape") return;
      block(e);
      this.stop(true);
    }

    onClick(e) {
      block(e);
      const id = this.idFromElement(e.target);
      this.stop();
      if (id) this.onPick(id);
    }

    // Maps a DOM element to the most specific node id that contains it.
    idFromElement(el) {
      return this.agent.view.tree.locate(el);
    }
  }

  const BLOCKED_EVENTS = [
    "mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend",
    "dblclick", "contextmenu", "auxclick",
  ];

  // Stops the selection click from also activating the field or button on the page.
  function block(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  NS.Picker = Picker;
})();
