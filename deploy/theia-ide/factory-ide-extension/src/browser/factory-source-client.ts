export type SourceOperation =
  | "stat"
  | "list"
  | "read"
  | "write"
  | "mkdir"
  | "rename"
  | "delete"
  | "search";

export interface SourceChange {
  readonly path: string;
  readonly kind: "added" | "updated" | "deleted" | "resync";
}

export interface SourceTransport {
  request(
    workspaceID: string,
    operation: SourceOperation,
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  watch(
    workspaceID: string,
    change: (event: SourceChange) => void,
    disconnected: (retrying?: boolean) => void,
  ): () => void;
}

export class SourceResponseError extends Error {
  constructor(
    readonly status: number,
    message?: string,
  ) {
    super(
      message ??
        (status === 409
          ? "Source changed. Keep your edits and resolve the conflict."
          : "Workspace source is unavailable."),
    );
  }
}

export function sourceChange(value: unknown): SourceChange {
  if (
    typeof value !== "object" ||
    value === null ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    !("kind" in value) ||
    (value.kind !== "added" &&
      value.kind !== "updated" &&
      value.kind !== "deleted" &&
      value.kind !== "resync")
  ) {
    throw new Error("Invalid source event");
  }
  return { path: value.path, kind: value.kind };
}

export class FactorySourceClient implements SourceTransport {
  constructor(
    private readonly base: URL,
    private readonly fetcher: (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response> = globalThis.fetch.bind(globalThis),
  ) {}

  private url(workspaceID: string, operation: string): URL {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(workspaceID))
      throw new Error("Invalid Workspace identity");
    return new URL(`__factory/workspaces/${workspaceID}/source/${operation}`, this.base);
  }

  async presentation(workspaceID: string): Promise<{ workspaceID: string; label: string }> {
    const response = await this.fetcher(this.url(workspaceID, "context"), {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new SourceResponseError(response.status);
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== "object" ||
      !("workspaceID" in value) ||
      value.workspaceID !== workspaceID ||
      !("label" in value) ||
      typeof value.label !== "string" ||
      !value.label.trim() ||
      value.label.length > 512
    )
      throw new Error("Workspace presentation is invalid");
    return { workspaceID, label: value.label };
  }

  async request(
    workspaceID: string,
    operation: SourceOperation,
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.fetcher(this.url(workspaceID, operation), {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const result: unknown = await response.json().catch(() => null);
      throw new SourceResponseError(
        response.status,
        result &&
          typeof result === "object" &&
          "error" in result &&
          typeof result.error === "string"
          ? result.error
          : undefined,
      );
    }
    return response.json();
  }

  watch(
    workspaceID: string,
    change: (event: SourceChange) => void,
    disconnected: (retrying?: boolean) => void,
  ): () => void {
    const url = this.url(workspaceID, "events");
    const lifetime = new AbortController();
    let events: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1_000;
    let probing = false;
    let received = 0;
    const closeEvents = () => {
      const current = events;
      events = undefined;
      if (current) {
        current.onmessage = null;
        current.onerror = null;
        current.close();
      }
    };
    const stop = () => {
      lifetime.abort();
      clearTimeout(retry);
      retry = undefined;
      closeEvents();
    };
    const connect = () => {
      if (lifetime.signal.aborted) return;
      const current = new EventSource(url);
      events = current;
      current.onmessage = (event) => {
        if (lifetime.signal.aborted || events !== current) return;
        try {
          const value: unknown = JSON.parse(event.data);
          const next = sourceChange(value);
          received++;
          delay = 1_000;
          clearTimeout(retry);
          retry = undefined;
          change(next);
        } catch {
          disconnected(false);
          stop();
        }
      };
      current.onerror = () => {
        if (lifetime.signal.aborted || events !== current) return;
        disconnected(true);
        if (probing) return;
        probing = true;
        const observed = received;
        void (async () => {
          try {
            await this.request(
              workspaceID,
              "stat",
              { path: "" },
              AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]),
            );
          } catch (error: unknown) {
            if (lifetime.signal.aborted || events !== current || received !== observed) return;
            if (error instanceof SourceResponseError && [401, 403, 404].includes(error.status)) {
              disconnected(false);
              stop();
              return;
            }
          } finally {
            probing = false;
          }
          if (
            lifetime.signal.aborted ||
            events !== current ||
            received !== observed ||
            retry !== undefined ||
            current.readyState !== EventSource.CLOSED
          )
            return;
          // A rejected HTTP stream can be permanently CLOSED even though root
          // access still works. Native reconnect only owns CONNECTING streams.
          // Retry reads on this same Workspace, never a save or runtime command.
          retry = setTimeout(() => {
            retry = undefined;
            if (
              lifetime.signal.aborted ||
              events !== current ||
              current.readyState !== EventSource.CLOSED
            )
              return;
            closeEvents();
            connect();
          }, delay);
          delay = Math.min(delay * 2, 5_000);
        })();
      };
    };
    connect();
    // The service emits resync on every connection, including reconnect. No
    // event backlog, heartbeat or source content is stored in product data.
    return stop;
  }
}
