import { expect, test } from "bun:test";
import { serveFactory } from "./http-listener";

test.each(["127.0.0.1", "0.0.0.0"])(
  "%s serves local runtime origins over both loopback families",
  async (hostname) => {
    const listeners = serveFactory(hostname, {
      port: 0,
      fetch: (request) => new Response(new URL(request.url).pathname),
    });
    try {
      const port = listeners[0]?.port;
      if (port === undefined) throw new Error("Missing Factory TCP listener");
      expect(await (await fetch(`http://127.0.0.1:${port}/runtime`)).text()).toBe("/runtime");
      expect(await (await fetch(`http://[::1]:${port}/runtime`)).text()).toBe("/runtime");
      expect(listeners.map((listener) => listener.hostname)).toEqual([hostname, "::1"]);
    } finally {
      await Promise.all(listeners.map((listener) => listener.stop(true)));
    }
  },
);
