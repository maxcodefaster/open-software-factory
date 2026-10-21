import { expect } from "bun:test";
import { appRuntimeOrigin } from "../../apps/factory/src/runtime-origins";
import { eventually } from "./factory-process";

const ClientSocket = WebSocket as typeof WebSocket & {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};

export async function runtimeAccessCookie(
  base: string,
  cookie: string,
  attemptID: string,
  channel: string,
) {
  const grant = await fetch(
    `${base}/api/runtime-access?${new URLSearchParams({ path: `/runtime/${attemptID}/${channel}/` })}`,
    { headers: { cookie }, redirect: "manual" },
  );
  expect(grant.status).toBe(302);
  const location = new URL(grant.headers.get("location") ?? "");
  if (channel !== "app" && channel !== "ide") throw new Error("Invalid runtime access channel");
  expect(location.origin).toBe(appRuntimeOrigin(base, attemptID, channel));
  expect(location.port).toBe(new URL(base).port);
  const redeemed = await fetch(`${base}${location.pathname}${location.search}`, {
    redirect: "manual",
  });
  expect(redeemed.status).toBe(302);
  return redeemed.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

export async function ownedRuntimeTerminal(
  base: string,
  cookie: string,
  attemptID: string,
  terminalID = "owned-browser-proof",
) {
  const runtimeCookie = await runtimeAccessCookie(base, cookie, attemptID, "ide");
  const socket = new ClientSocket(
    `${base.replace("http:", "ws:")}/runtime/${attemptID}/ide/__factory/terminal/${terminalID}`,
    { headers: { cookie: runtimeCookie } },
  );
  socket.binaryType = "arraybuffer";
  let output = "";
  socket.addEventListener("message", (event) => {
    output = (
      output + (typeof event.data === "string" ? event.data : Buffer.from(event.data).toString())
    ).slice(-100_000);
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Owned terminal attach exceeded its bound"));
    }, 15_000);
    socket.addEventListener("message", (event) => {
      if (event.data !== '{"type":"terminal-ready"}') return;
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timeout);
        reject(new Error("Owned terminal closed before attachment"));
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("Owned terminal attach failed"));
      },
      { once: true },
    );
  });
  return {
    runtimeCookie,
    close: () => socket.close(),
    async evaluate<T>(source: string): Promise<T> {
      const marker = `FACTORY_RESULT_${crypto.randomUUID().replaceAll("-", "")}_`;
      const script = `(async () => { try { const value = await (async () => { ${source} })(); console.log(${JSON.stringify(marker)} + Buffer.from(JSON.stringify({ value })).toString("base64")); } catch (cause) { console.log(${JSON.stringify(marker)} + Buffer.from(JSON.stringify({ error: String(cause.message).slice(0, 300) })).toString("base64")); } })()`;
      socket.send(
        Buffer.from(
          `node -e 'eval(Buffer.from("${Buffer.from(script).toString("base64")}", "base64").toString())'\n`,
        ),
      );
      const match = await eventually(
        async () => new RegExp(`${marker}([A-Za-z0-9+/=]+)`).exec(output),
        (value) => value !== null,
        "Owned terminal command did not finish",
      ).catch(() => {
        throw new Error(
          `Owned terminal command did not finish; socket=${socket.readyState}, receivedBytes=${output.length}`,
        );
      });
      const result = JSON.parse(Buffer.from(match?.[1] ?? "", "base64").toString()) as {
        value: T;
        error?: string;
      };
      if (result.error) throw new Error(`Owned terminal command failed: ${result.error}`);
      return result.value;
    },
  };
}
