import { expect, test } from "bun:test";
import { pinnedOpenCode, observe } from "../fixtures/pinned-opencode";
import { buildModelID } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import { ensureOpenCodeMessageBoundary } from "../../apps/factory/src/agent/opencode-client";
import { createUsageJournal } from "../../apps/factory/src/usage/journal";
import { drainOpenCodeUsage } from "../../apps/factory/src/usage/opencode";
import { createContractRates } from "../../apps/factory/src/usage/contract-rates";

test.skipIf(process.env["FACTORY_RUN_USAGE_MODEL_PROOF"] !== "1")(
  "actual configured Coding model reports native consumption through the exact runtime artifact",
  async () => {
    const baseURL = process.env["FACTORY_MODEL_BASE_URL"];
    const key = process.env["FACTORY_MODEL_API_KEY"];
    if (!baseURL || !key || !process.env["FACTORY_AGENT_MODEL_ID"])
      throw new Error("Configured Coding provider required");
    let calls = 0;
    const provider = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/v1/chat/completions") return new Response(null, { status: 404 });
        const body = await request.json();
        if (body.model !== buildModelID) return new Response(null, { status: 403 });
        calls++;
        const response = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        });
        console.log("Owned live provider response", { status: response.status, calls });
        if (!response.ok) {
          await response.body?.cancel();
          return Response.json(
            { error: { message: "Configured provider request failed", type: "provider_error" } },
            { status: response.status },
          );
        }
        return new Response(response.body, {
          status: response.status,
          headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
        });
      },
    });
    const native = await pinnedOpenCode(
      undefined,
      undefined,
      undefined,
      `http://host.docker.internal:${provider.port}/v1`,
    );
    const processFixture = await factoryProcess();
    const database = processFixture.connect();
    const journal = createUsageJournal(database);
    const id = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
    const operationID = `owned:${crypto.randomUUID()}`;
    try {
      await native.client.session.create({
        id,
        title: "Owned real usage",
        location: { directory: "/workspace/project" },
        model: { providerID: "factory", id: buildModelID },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      });
      await ensureOpenCodeMessageBoundary(native.client, id);
      await journal.begin({
        id: operationID,
        projectID: null,
        userID: null,
        purpose: "coding",
        engine: "opencode",
        provider: "openai",
        model: buildModelID,
        rate: await createContractRates(database).get("openai", buildModelID),
      });
      await native.client.session.prompt({
        sessionID: id,
        id: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
        text: "Run bash command printf factory-usage exactly once, then answer briefly with its output. Do not change files.",
        delivery: "queue",
        resume: true,
      });
      await observe(
        async () => {
          const info = await native.client.session.get({ sessionID: id });
          if (info.outcome === "failed" || info.outcome === "interrupted")
            throw new Error(`Configured native Coding ${info.outcome}, provider calls=${calls}`);
          return info;
        },
        (info) => info.outcome === "succeeded",
        "Configured native Coding request did not succeed",
        90000,
      );
      const drain = () =>
        drainOpenCodeUsage({
          sessionID: id,
          after: 0,
          log: (after) =>
            native.client.session.log(
              { sessionID: id, after, follow: false },
              { signal: AbortSignal.timeout(5000) },
            ),
          record: (entry, sequence) =>
            journal.record(operationID, entry, { sessionID: id, sequence }),
          advance: (sequence) => journal.advance(operationID, id, sequence),
        });
      await drain();
      const read = async () => [
        ...(await database.client`
        SELECT source,counters,nano_usd FROM factory.usage_entry WHERE operation_id=${operationID} ORDER BY event_id`),
      ];
      const consumption = await read();
      expect(consumption.some((entry) => entry["source"] === "step")).toBe(true);
      expect(
        consumption.reduce(
          (total, entry) =>
            total + (entry["counters"].input ?? 0) + (entry["counters"].output ?? 0),
          0,
        ),
      ).toBeGreaterThan(0);
      expect(calls).toBeGreaterThanOrEqual(2);
      await drain();
      expect(await read()).toEqual(consumption);
      await journal.settle(operationID, "completed");
      console.log(
        JSON.stringify({
          model: buildModelID,
          nativeCalls: calls,
          recordedEntries: consumption.length,
        }),
      );
    } finally {
      await native.dispose();
      await database.client.end({ timeout: 2 });
      await processFixture.dispose();
      await provider.stop(true);
    }
  },
  180000,
);
