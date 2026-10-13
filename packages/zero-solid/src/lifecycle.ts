import type { ConnectionState, ErroredQuery, ResultType, TypedView } from "@rocicorp/zero";

export interface ZeroLifecycleIdentity {
  readonly userId: string;
  readonly schemaVersion: string;
  readonly auth?: string;
}
export interface ZeroLifecycleClient {
  readonly connection: { readonly state: { readonly current: ConnectionState } };
  close(): Promise<void>;
}

export class ZeroClientLifecycle<T extends ZeroLifecycleClient> {
  #key: string | undefined;
  #client: T | undefined;

  select(identity: ZeroLifecycleIdentity | null, create: (identity: ZeroLifecycleIdentity) => T) {
    const key = identity ? `${identity.userId}:${identity.schemaVersion}` : undefined;
    if (!identity || !key) {
      this.dispose();
      return undefined;
    }
    if (this.#key === key) return this.#client;
    this.dispose();
    this.#key = key;
    this.#client = create(identity);
    return this.#client;
  }

  dispose() {
    void this.#client?.close();
    this.#client = undefined;
    this.#key = undefined;
  }
}

export function listenToMaterializedView<T>(
  view: TypedView<T>,
  listener: (state: { data: T; completeness: ResultType; error: ErroredQuery | undefined }) => void,
) {
  const unsubscribe = view.addListener((data, completeness, error) =>
    listener({ data: data as T, completeness, error }),
  );
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    view.destroy();
  };
}
