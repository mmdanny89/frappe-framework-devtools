// Box that marks an element on the page, like the Vue DevTools highlight.

(() => {
  const NS = (window.FrappeDevtools ??= {});

  class Highlighter {
    show(element, label) {
      if (!element) return this.hide();
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      const rect = element.getBoundingClientRect();
      const box = this.ensureBox();
      Object.assign(box.style, {
        display: "block",
        top: `${rect.top}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      this.tag.textContent = label || "";
      this.tag.style.display = label ? "block" : "none";
    }

    hide() {
      if (this.box) this.box.style.display = "none";
    }

    ensureBox() {
      if (this.box?.isConnected) return this.box;
      this.box = document.createElement("div");
      Object.assign(this.box.style, {
        position: "fixed",
        zIndex: "2147483647",
        pointerEvents: "none",
        border: "2px solid #2490ef",
        background: "rgba(36, 144, 239, 0.12)",
        borderRadius: "4px",
        boxSizing: "border-box",
      });
      this.tag = document.createElement("div");
      Object.assign(this.tag.style, {
        position: "absolute",
        top: "-22px",
        left: "-2px",
        padding: "2px 6px",
        font: "11px/16px monospace",
        color: "#fff",
        background: "#2490ef",
        borderRadius: "3px",
        whiteSpace: "nowrap",
      });
      this.box.appendChild(this.tag);
      document.documentElement.appendChild(this.box);
      return this.box;
    }
  }

  NS.Highlighter = Highlighter;
})();
