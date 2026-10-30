// Reading editing status never requests or transfers editing authority.
export class FactoryWriterDialog {
  readonly element = document.createElement("dialog");
  readonly copy = document.createElement("p");
  readonly action = document.createElement("button");

  constructor(onAction: () => void) {
    this.element.className = "factory-writer-status";
    this.element.setAttribute("aria-label", "Editing access");
    this.copy.id = `factory-writer-copy-${crypto.randomUUID()}`;
    this.copy.textContent = "Checking editing access…";
    this.element.setAttribute("aria-describedby", this.copy.id);
    this.action.type = "button";
    this.action.className = "theia-button";
    this.action.hidden = true;
    this.action.addEventListener("click", onAction);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "theia-button secondary";
    close.textContent = "Close";
    close.autofocus = true;
    close.addEventListener("click", () => this.close());
    const actions = document.createElement("div");
    actions.className = "factory-writer-actions";
    actions.append(this.action, close);
    this.element.append(this.copy, actions);
    this.element.addEventListener("click", (event) => {
      if (event.target !== this.element) return;
      const bounds = this.element.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        this.close();
    });
  }

  open() {
    if (!this.element.open) this.element.showModal();
  }

  close() {
    this.element.close();
  }

  dispose() {
    this.close();
    this.element.remove();
  }
}
