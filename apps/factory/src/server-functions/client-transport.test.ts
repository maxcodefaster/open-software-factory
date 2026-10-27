import { expect, test } from "bun:test";
import {
  configureServerFunctionsClient,
  createServerReference,
  invoke,
} from "@solidjs/web/server-functions/client";
import { configureFactoryFunctionClient } from "./client-transport";

test("native transport keeps only draft retention alive and preserves the invocation signal without replay", async () => {
  const sent: RequestInit[] = [];
  const retention = createServerReference("owned-retention");
  const ordinary = createServerReference("owned-command");
  const controller = new AbortController();
  try {
    configureFactoryFunctionClient({ serverFnMeta: { id: "owned-retention" } });
    // Start configures its endpoint/codec as references load. That must not
    // replace the narrowly scoped native request hook.
    configureServerFunctionsClient({
      endpoint: "https://owned-functions.invalid/_server",
      fetch: async (_address, init) => {
        sent.push(init);
        throw new Error("Owned transport failure");
      },
    });
    await expect(invoke(retention, { signal: controller.signal })).rejects.toThrow(
      "Owned transport failure",
    );
    await expect(ordinary()).rejects.toThrow("Owned transport failure");
    expect(sent).toHaveLength(2);
    expect(sent[0]?.keepalive).toBe(true);
    expect(sent[0]?.signal).toBe(controller.signal);
    expect(sent[0]?.method).toBe("POST");
    expect(sent[1]?.keepalive).not.toBe(true);
  } finally {
    configureServerFunctionsClient({
      endpoint: "/_server",
      fetch: null,
      prepareRequest: (init) => init,
    });
  }
});
