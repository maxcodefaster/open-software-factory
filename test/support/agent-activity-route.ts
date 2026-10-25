import type { AgentView } from "../../apps/factory/src/api-contracts";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { agentActivityStream } from "../../apps/factory/src/agent/activity-stream";

// A controlled native observation source. The browser still goes through the
// real compiled function, its wire codec and an actual HTTP stream.
export async function streamedAgentView(initial: AgentView) {
  let view = initial,
    requests = 0,
    epoch = 0;
  const readers = new Set<() => void>(),
    connections = new Set<AbortController>();
  const activity: FactoryServices["agent"]["activity"] = async (
    _actor,
    _changeID,
    signal,
    session,
  ) => {
    requests++;
    const version = epoch,
      own = new AbortController();
    connections.add(own);
    return agentActivityStream({
      signal: AbortSignal.any([signal, own.signal]),
      authorize: async () => {
        await session();
        if (version !== epoch) throw new Error("Controlled observation disconnect");
      },
      read: async () => view,
      subscribe: async (notify) => {
        readers.add(notify);
        return () => {
          readers.delete(notify);
          connections.delete(own);
        };
      },
      reconcileMS: 60_000,
      coalesceMS: 0,
    });
  };
  return {
    activity,
    requests: () => requests,
    readers: () => readers.size,
    publish(next: AgentView) {
      view = next;
      for (const notify of readers) notify();
    },
    disconnect() {
      epoch++;
      for (const notify of readers) notify();
    },
    async dispose() {
      for (const connection of connections) connection.abort();
    },
  };
}
