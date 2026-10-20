import type { ServerWebSocket } from "bun";
import type { RuntimeHub, RuntimeSocketData } from "./hub";

// Bun invokes socket callbacks synchronously. Keep interactive input ordered while
// each open/input acquires durable authority at the actual Connector send boundary.
export function createRuntimeWriterBoundary(
  hub: RuntimeHub,
  authorize: (data: RuntimeSocketData, send: () => void) => Promise<void>,
) {
  const queues = new WeakMap<
    ServerWebSocket<RuntimeSocketData>,
    { tail: Promise<void>; bytes: number; closed: boolean }
  >();
  function enqueue(socket: ServerWebSocket<RuntimeSocketData>, bytes: number, send: () => void) {
    const queue = queues.get(socket);
    if (!queue || queue.closed) return;
    queue.bytes += bytes;
    if (queue.bytes > 1 << 20) {
      queue.closed = true;
      socket.close(1009, "Interactive input limit exceeded");
      hub.close(socket);
      return;
    }
    queue.tail = queue.tail
      .then(async () => {
        if (!queue.closed)
          await authorize(socket.data, () => {
            if (!queue.closed) send();
          });
      })
      .catch(() => {
        queue.closed = true;
        socket.close(1008, "Editing authority changed");
        hub.close(socket);
      })
      .finally(() => {
        queue.bytes -= bytes;
      });
  }
  return {
    open(socket: ServerWebSocket<RuntimeSocketData>) {
      if (socket.data.kind !== "browser" || !["terminal", "language"].includes(socket.data.channel))
        return hub.open(socket);
      queues.set(socket, { tail: Promise.resolve(), bytes: 0, closed: false });
      enqueue(socket, 0, () => hub.open(socket));
    },
    message(socket: ServerWebSocket<RuntimeSocketData>, message: string | Buffer) {
      if (socket.data.kind !== "browser" || !["terminal", "language"].includes(socket.data.channel))
        return hub.message(socket, message);
      enqueue(socket, Buffer.byteLength(message), () => hub.message(socket, message));
    },
    close(socket: ServerWebSocket<RuntimeSocketData>) {
      const queue = queues.get(socket);
      if (queue) queue.closed = true;
      queues.delete(socket);
      hub.close(socket);
    },
  };
}
