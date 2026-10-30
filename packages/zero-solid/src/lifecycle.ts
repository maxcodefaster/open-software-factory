import type {
  Connection,
  ConnectionState,
  ErroredQuery,
  ResultType,
  TypedView,
} from "@rocicorp/zero";

type ReconnectSchedule = (action: () => void, delay: number) => () => void;
const scheduleReconnect: ReconnectSchedule = (action, delay) => {
  const timer = setTimeout(action, delay + Math.random() * delay * 0.2);
  return () => clearTimeout(timer);
};

export function isTransientAPIConnectionError(state: ConnectionState | undefined) {
  // Zero 1.10 exposes the public error message, not the underlying protocol body.
  // Resume only its known API transport/5xx failures, never arbitrary fatal errors.
  return (
    state?.name === "error" &&
    (state.reason === "Fetch from API server threw error: fetch failed" ||
      /^Fetch from API server returned non-OK status 5\d\d$/.test(state.reason))
  );
}

function recoverAPIConnection(connection: Connection, schedule: ReconnectSchedule) {
  let disposed = false;
  let inFlight = false;
  let cancel: (() => void) | undefined;
  let delay = 5_000;
  function observe(state: ConnectionState) {
    if (disposed) return;
    if (state.name === "connected") delay = 5_000;
    if (!isTransientAPIConnectionError(state)) {
      cancel?.();
      cancel = undefined;
      return;
    }
    if (cancel || inFlight) return;
    cancel = schedule(() => {
      cancel = undefined;
      if (disposed || !isTransientAPIConnectionError(connection.state.current)) return;
      inFlight = true;
      const settled = () => {
        inFlight = false;
        observe(connection.state.current);
      };
      void Promise.resolve()
        .then(() => {
          if (!disposed && isTransientAPIConnectionError(connection.state.current))
            return connection.connect();
        })
        .then(settled, settled);
    }, delay);
    delay = Math.min(delay * 2, 30_000);
  }
  const unsubscribe = connection.state.subscribe(observe);
  observe(connection.state.current);
  return () => {
    disposed = true;
    cancel?.();
    unsubscribe();
  };
}

export interface ZeroLifecycleIdentity {
  readonly userId: string;
  readonly schemaVersion: string;
  readonly auth?: string;
}
export interface ZeroLifecycleClient {
  readonly connection: Connection;
  close(): Promise<void>;
}

export class ZeroClientLifecycle<T extends ZeroLifecycleClient> {
  #key: string | undefined;
  #client: T | undefined;
  #auth: string | undefined;
  #stopRecovery: (() => void) | undefined;
  readonly #schedule: ReconnectSchedule;

  constructor(schedule: ReconnectSchedule = scheduleReconnect) {
    this.#schedule = schedule;
  }

  select(identity: ZeroLifecycleIdentity | null, create: (identity: ZeroLifecycleIdentity) => T) {
    const key = identity ? `${identity.userId}:${identity.schemaVersion}` : undefined;
    if (!identity || !key) {
      this.dispose();
      return undefined;
    }
    if (this.#key === key) {
      if (identity.auth !== undefined && identity.auth !== this.#auth)
        void this.#client?.connection.connect({ auth: identity.auth }).catch(() => {});
      this.#auth = identity.auth;
      return this.#client;
    }
    this.dispose();
    this.#key = key;
    this.#auth = identity.auth;
    this.#client = create(identity);
    this.#stopRecovery = recoverAPIConnection(this.#client.connection, this.#schedule);
    return this.#client;
  }

  dispose() {
    this.#stopRecovery?.();
    this.#stopRecovery = undefined;
    void this.#client?.close();
    this.#client = undefined;
    this.#key = undefined;
    this.#auth = undefined;
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
