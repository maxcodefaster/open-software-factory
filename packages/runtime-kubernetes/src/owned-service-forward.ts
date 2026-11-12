// Both file access and the editor must own an opening before resource validation
// yields. A closed opening can finish validation, but can never create a process.
export interface OwnedServiceForward {
  endpoint: Promise<string>;
  cancel: AbortController;
  child: { exited: Promise<number>; kill(): void };
}

type ForwardState =
  | { phase: "opening"; forward: OwnedServiceForward | null }
  | { phase: "connected"; forward: OwnedServiceForward }
  | { phase: "closed" };

type Connection = { origin: string; cancel: AbortController };

export function createOwnedServiceForwards<Owner>(label: "Source" | "Developer IDE") {
  const connections = new Map<
    string,
    {
      owner: Owner;
      state: ForwardState;
      ready: ReturnType<typeof Promise.withResolvers<Connection>>;
    }
  >();

  function close(
    key: string,
    connection: NonNullable<ReturnType<typeof connections.get>>,
    cause: unknown = new Error(`${label} connection closed`),
    kill = true,
  ) {
    if (connection.state.phase === "closed") return;
    const forward = connection.state.forward;
    connection.state = { phase: "closed" };
    // A delayed exit or validation failure owns this entry, never its replacement.
    if (connections.get(key) === connection) connections.delete(key);
    connection.ready.reject(cause);
    if (forward) {
      forward.cancel.abort();
      if (kill) forward.child.kill();
    }
  }

  return {
    open(
      key: string,
      owner: Owner,
      validate: () => Promise<void>,
      start: () => OwnedServiceForward,
    ) {
      const retained = connections.get(key);
      if (retained) return retained.ready.promise;
      const connection = {
        owner,
        state: { phase: "opening", forward: null } as ForwardState,
        ready: Promise.withResolvers<Connection>(),
      };
      connections.set(key, connection);
      void connection.ready.promise.catch(() => {});
      void (async () => {
        try {
          await validate();
          if (connections.get(key) !== connection) return;
          const forward = start();
          connection.state = { phase: "opening", forward };
          void forward.child.exited.then(() => {
            close(key, connection, new Error(`${label} connection closed`), false);
          });
          const origin = await forward.endpoint;
          if (connections.get(key) !== connection) return;
          connection.state = { phase: "connected", forward };
          connection.ready.resolve({ origin, cancel: forward.cancel });
        } catch (cause) {
          close(key, connection, cause);
        }
      })();
      return connection.ready.promise;
    },
    disconnect(matches: (owner: Owner) => boolean) {
      for (const [key, connection] of connections) {
        if (matches(connection.owner)) close(key, connection);
      }
    },
    close() {
      for (const [key, connection] of connections) close(key, connection);
    },
  };
}
