type Kind = "edit" | "heartbeat";
type Scope = {
  epoch: number;
  cancellation: AbortController;
  pending?: Kind;
  timer?: ReturnType<typeof setTimeout>;
  busy: boolean;
};

/** Courtesy signals keep the original buffer/Terminal identity, never the current Explorer. */
export class FactoryEditingActivity {
  readonly #scopes = new Map<string, Scope>();
  constructor(
    private readonly send: (
      workspaceID: string,
      epoch: number,
      kind: Kind,
      signal: AbortSignal,
    ) => Promise<boolean>,
  ) {}

  confirm(workspaceID: string, epoch: number | undefined) {
    const previous = this.#scopes.get(workspaceID);
    if (previous?.epoch === epoch) return;
    if (previous) {
      previous.cancellation.abort();
      clearTimeout(previous.timer);
      this.#scopes.delete(workspaceID);
    }
    if (epoch !== undefined)
      this.#scopes.set(workspaceID, { epoch, cancellation: new AbortController(), busy: false });
  }

  queue(workspaceID: string, kind: Kind) {
    const scope = this.#scopes.get(workspaceID);
    if (!scope) return;
    if (scope.pending !== "edit") scope.pending = kind;
    if (scope.timer !== undefined || scope.busy) return;
    scope.timer = setTimeout(() => {
      void this.flush(workspaceID);
    }, 1_000);
  }

  async flush(workspaceID: string) {
    const scope = this.#scopes.get(workspaceID);
    if (!scope || scope.busy) return;
    clearTimeout(scope.timer);
    scope.timer = undefined;
    const kind = scope.pending;
    if (!kind) return;
    scope.pending = undefined;
    scope.busy = true;
    try {
      const current = await this.send(workspaceID, scope.epoch, kind, scope.cancellation.signal);
      if (!current && this.#scopes.get(workspaceID) === scope) this.confirm(workspaceID, undefined);
    } catch {
      // Presence does not grant authority or replay an operation.
    } finally {
      scope.busy = false;
      if (this.#scopes.get(workspaceID) === scope && scope.pending)
        this.queue(workspaceID, scope.pending);
    }
  }

  close() {
    for (const workspaceID of this.#scopes.keys()) this.confirm(workspaceID, undefined);
  }
}
