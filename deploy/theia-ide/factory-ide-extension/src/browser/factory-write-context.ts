// Presentation only. Every mutation is separately authorized by Factory.
export class FactoryWriteContext {
  readonly #listeners = new Set<() => void>();
  #workspaceID: string | undefined;
  #allowed = false;
  select(workspaceID: string | undefined) {
    this.#workspaceID = workspaceID;
    this.#allowed = false;
    this.#notify();
  }
  confirm(workspaceID: string, allowed: boolean) {
    if (workspaceID !== this.#workspaceID || allowed === this.#allowed) return;
    this.#allowed = allowed;
    this.#notify();
  }
  allows(workspaceID: string) {
    return workspaceID === this.#workspaceID && this.#allowed;
  }
  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }
  #notify() {
    for (const listener of this.#listeners) listener();
  }
}
export const factoryWriteContext = new FactoryWriteContext();
