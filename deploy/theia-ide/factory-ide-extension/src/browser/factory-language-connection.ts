import {
  AbstractMessageReader,
  AbstractMessageWriter,
  createMessageConnection,
  type DataCallback,
  type Message,
  type Disposable,
  type MessageConnection,
  type CancellationToken,
} from "vscode-jsonrpc/browser";

const maxMessageBytes = 1 << 20;

class SocketReader extends AbstractMessageReader {
  private detach: (() => void) | undefined;
  constructor(private readonly socket: WebSocket) {
    super();
  }
  listen(callback: DataCallback): Disposable {
    const message = (event: MessageEvent<unknown>) => {
      try {
        if (typeof event.data !== "string" || event.data.length > maxMessageBytes)
          throw new Error("Language response is too large.");
        const value: unknown = JSON.parse(event.data);
        if (!value || typeof value !== "object" || !("jsonrpc" in value) || value.jsonrpc !== "2.0")
          throw new Error("Language response is invalid.");
        callback(value as Message);
      } catch (cause) {
        this.fireError(cause);
        this.socket.close(1002);
      }
    };
    const close = () => this.fireClose();
    this.socket.addEventListener("message", message);
    this.socket.addEventListener("close", close);
    this.detach = () => {
      this.socket.removeEventListener("message", message);
      this.socket.removeEventListener("close", close);
    };
    return {
      dispose: () => {
        this.detach?.();
        this.detach = undefined;
      },
    };
  }
  override dispose() {
    this.detach?.();
    this.detach = undefined;
    super.dispose();
  }
}

class SocketWriter extends AbstractMessageWriter {
  constructor(private readonly socket: WebSocket) {
    super();
  }
  async write(message: Message) {
    const body = JSON.stringify(message);
    if (
      this.socket.readyState !== WebSocket.OPEN ||
      new TextEncoder().encode(body).byteLength > maxMessageBytes ||
      this.socket.bufferedAmount > maxMessageBytes
    ) {
      this.socket.close(1009, "Language connection is unavailable.");
      throw new Error("Language connection is unavailable.");
    }
    this.socket.send(body);
  }
  end() {
    this.socket.close();
  }
}

// Use Microsoft's JSON-RPC implementation for request ordering, cancellation,
// response matching and disposal. A reconnect creates a new connection and
// reopens buffers; it never replays an old request.
export function languageConnection(socket: WebSocket) {
  const reader = new SocketReader(socket);
  const writer = new SocketWriter(socket);
  const connection = createMessageConnection(reader, writer);
  connection.onDispose(() => {
    reader.dispose();
    writer.dispose();
    socket.close();
  });
  connection.listen();
  return connection;
}

// A successful handshake does not prove that the analysis worker is healthy.
// Bound reads too, close an unresponsive connection, and never replay it.
export function languageRequest<T>(
  connection: MessageConnection,
  socket: WebSocket,
  method: string,
  params: unknown,
  token?: CancellationToken,
  timeoutMS = 20_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      socket.close(1011, "Language server did not respond.");
      reject(new Error("Language server did not respond. Reconnect project tools to retry."));
    }, timeoutMS);
  });
  const response = token
    ? connection.sendRequest<T>(method, params, token)
    : connection.sendRequest<T>(method, params);
  return Promise.race([response, deadline]).finally(() => clearTimeout(timeout));
}
