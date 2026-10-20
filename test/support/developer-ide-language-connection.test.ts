import { expect, test } from "bun:test";
import {
  languageConnection,
  languageRequest,
} from "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-language-connection";

class Socket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: Array<{ id?: number; method?: string }> = [];
  send(body: string) {
    this.sent.push(JSON.parse(body));
  }
  close() {
    if (this.readyState !== WebSocket.OPEN) return;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
  receive(body: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(body) }));
  }
  get socket() {
    return this as unknown as WebSocket;
  }
}

test("language reconnect rejects old requests and never repeats them or accepts an old connection's result", async () => {
  const oldSocket = new Socket();
  const old = languageConnection(oldSocket.socket);
  const pending = old.sendRequest("textDocument/completion", {
    textDocument: { uri: "factory-workspace://workspace-a/app.ts" },
  });
  const rejected = pending.then(
    () => ({ rejected: false, error: undefined }),
    (error: unknown) => ({ rejected: true, error }),
  );
  await Bun.sleep(0);
  expect(oldSocket.sent).toHaveLength(1);
  old.dispose();
  expect(await rejected).toMatchObject({ rejected: true, error: expect.any(Error) });
  const nextSocket = new Socket();
  const next = languageConnection(nextSocket.socket);
  try {
    expect(nextSocket.sent).toHaveLength(0);
    let settled = false;
    const result = next
      .sendRequest<string>("textDocument/hover", {
        textDocument: { uri: "factory-workspace://workspace-b/app.ts" },
      })
      .then((value) => {
        settled = true;
        return value;
      });
    await Bun.sleep(0);
    oldSocket.receive({ jsonrpc: "2.0", id: oldSocket.sent[0]?.id, result: "old workspace" });
    await Bun.sleep(0);
    expect(settled).toBe(false);
    nextSocket.receive({ jsonrpc: "2.0", id: nextSocket.sent[0]?.id, result: "new workspace" });
    expect(await result).toBe("new workspace");
    expect(nextSocket.sent).toHaveLength(1);
    expect(oldSocket.sent).toHaveLength(1);
  } finally {
    next.dispose();
  }
});

test("an initialized language server with an unresponsive worker cannot leave reads hanging or replay them", async () => {
  const socket = new Socket();
  const connection = languageConnection(socket.socket);
  try {
    const result = await languageRequest(
      connection,
      socket.socket,
      "textDocument/completion",
      {},
      undefined,
      10,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(Error);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(socket.sent).toHaveLength(1);
  } finally {
    connection.dispose();
  }
});

test("language transport closes malformed or oversized messages without dispatching them", async () => {
  for (const body of ['{"jsonrpc":"wrong"}', "x".repeat((1 << 20) + 1)]) {
    const socket = new Socket();
    const connection = languageConnection(socket.socket);
    let notifications = 0;
    connection.onNotification(() => {
      notifications++;
    });
    socket.dispatchEvent(new MessageEvent("message", { data: body }));
    await Bun.sleep(0);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(notifications).toBe(0);
    connection.dispose();
  }
});
