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
    disconnected: () => void,
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
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  private url(workspaceID: string, operation: string): URL {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(workspaceID))
      throw new Error("Invalid Workspace identity");
    return new URL(`__factory/workspaces/${workspaceID}/source/${operation}`, this.base);
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
    disconnected: () => void,
  ): () => void {
    const events = new EventSource(this.url(workspaceID, "events"));
    events.onmessage = (event) => {
      try {
        const value: unknown = JSON.parse(event.data);
        change(sourceChange(value));
      } catch {
        disconnected();
        events.close();
      }
    };
    events.onerror = () => {
      disconnected();
      void this.request(workspaceID, "stat", { path: "" }).catch((error: unknown) => {
        if (error instanceof SourceResponseError && error.status === 403) events.close();
      });
    };
    // The service emits resync on every connection, including reconnect. No
    // event backlog, heartbeat or source content is stored in product data.
    return () => events.close();
  }
}
