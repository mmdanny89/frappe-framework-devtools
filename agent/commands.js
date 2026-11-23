// Answers the commands of the DevTools panel and the background script.
// The agent (agent/agent.js) owns the state, the view and the tree updates. This class only
// reads it and calls it.

(() => {
  const NS = (window.FrappeDevtools ??= {});

  class Commands {
    constructor(agent) {
      this.agent = agent;
    }

    handle(msg) {
      const agent = this.agent;
      if (msg.type === "status") return agent.sendStatus();
      if (msg.type === "panel-closed") return this.panelClosed();
      // Any command proves that a panel is open, even if a "panel-closed" arrived out of order.
      agent.panelSeen = true;
      if (msg.type === "hello") return this.hello();
      if (agent.state !== "active") return agent.sendStatus();
      switch (msg.type) {
        case "tree": return agent.sendTree();
        case "inspect": return this.inspect(msg.id);
        case "highlight": return this.highlight(msg.id);
        case "pick": return msg.on ? this.startPicker() : agent.picker.stop();
        case "info": return agent.send({ type: "info", mode: agent.mode, ...agent.view.inspector.info() });
        case "action": return this.runAction(msg.id, msg.action, msg.confirmed === true);
        case "timeline": return agent.send({ type: "timeline", events: agent.timeline.all() });
        case "timeline-clear": return agent.timeline.clear();
        case "form-tool": return this.setFormTool(msg.tool, msg.on);
        case "expand": return this.expandRow(msg.id, msg.open);
      }
    }

    // The last DevTools panel of this tab closed: stop everything that changes the page.
    panelClosed() {
      const agent = this.agent;
      agent.panelSeen = false;
      agent.picker.stop();
      agent.highlighter.hide();
      agent.formTools?.stop();
    }

    hello() {
      const agent = this.agent;
      agent.sendStatus();
      if (agent.state === "active") agent.sendTree();
      if (agent.formTools) this.sendFormTools();
    }

    inspect(id) {
      const { view } = this.agent;
      const target = view.tree.resolve(id);
      if (!target) return this.agent.send({ type: "inspect", id, missing: true });
      this.agent.send({ type: "inspect", id, ...view.inspector.inspect(target) });
    }

    highlight(id) {
      const { view, highlighter } = this.agent;
      const target = id && view.tree.resolve(id);
      highlighter.show(target && view.inspector.element(target), id);
    }

    runAction(id, action, confirmed) {
      const { view } = this.agent;
      const target = view.tree.resolve(id);
      const result = target && view.inspector.action(target, action, confirmed);
      this.agent.send({ type: "action-done", id, action, result });
      this.agent.schedulePush();
    }

    // A picked cell needs its row open in the tree first, so the panel can select it.
    startPicker() {
      const agent = this.agent;
      agent.picker.start({
        onPick: (id) => {
          agent.view.tree.openPathTo?.(id);
          agent.sendTree();
          agent.send({ type: "picked", id });
        },
        onCancel: () => agent.send({ type: "pick-cancelled" }),
      });
    }

    // Form tools exist only in Desk mode.
    setFormTool(tool, on) {
      const agent = this.agent;
      if (!agent.formTools) return;
      agent.formTools.set(tool, on);
      agent.syncFormTools();
      this.sendFormTools();
      agent.schedulePush();
    }

    sendFormTools() {
      this.agent.send({ type: "form-tools", ...this.agent.formTools.state() });
    }

    // Desk rows send their cells only while the panel has them open.
    expandRow(id, open) {
      this.agent.view.tree.setRowOpen?.(id, open);
      this.agent.schedulePush();
    }
  }

  NS.Commands = Commands;
})();
