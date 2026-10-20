import { expect, test } from "bun:test";
import { decodeOpenCodeAdmission } from "../../apps/factory/src/agent/opencode-client";
import { createOpenCodeEvents } from "../../apps/factory/src/agent/opencode-events";
import { buildModelID } from "../fixtures/change-agent-turns";
import { connectorBoundary } from "../fixtures/connector-boundary";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

test("Connector interruption follows native prompt admission despite response/control loss", async () => {
  const process = await pinnedOpenCode();
  try {
    const boundary = await connectorBoundary(process);
    const events = createOpenCodeEvents(() => boundary.client);
    const observed: string[] = [];
    const detach = events.subscribe("owned", (type) => observed.push(type));
    try {
      await observe(
        async () => observed,
        (types) => types.includes("server.connected"),
      );
      for (const loss of ["none", "stream-close", "reconnect"] as const) {
        const input = {
          sessionID: `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`,
          promptID: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
          text: `Owned ${loss} admission proof`,
          bootstrap: false,
        };
        await boundary.client.session.create({
          id: input.sessionID,
          location: { directory: "/workspace/project" },
          model: { providerID: "factory", id: buildModelID },
        });
        const delay = await boundary.delay(loss);
        const prompt = delay.client.session
          .prompt({
            sessionID: input.sessionID,
            id: input.promptID,
            text: input.text,
            delivery: "queue",
            resume: false,
          })
          .then(
            (result) => ({ ok: true as const, result }),
            () => ({ ok: false as const }),
          );
        try {
          await delay.detach();
          const interrupt = boundary.client.session.interrupt({ sessionID: input.sessionID });
          // The real agent read path is responsive while mutation admission waits.
          await boundary.client.server.info();
          const early = await Promise.race([
            delay.interrupted.promise.then(() => true),
            Bun.sleep(100).then(() => false),
          ]);
          expect(early).toBe(false);
          delay.release.resolve();
          await interrupt;
          expect(await delay.interrupted.promise).toBe(false);
          const result = await prompt;
          expect(result.ok).toBe(loss === "none");
          if (result.ok) expect(decodeOpenCodeAdmission(result.result, input).state).toBe("queued");
          expect((await process.control()).providerRequests).toBe(0);
        } finally {
          delay.release.resolve();
          await prompt;
        }
      }
      expect(observed).toContain("session.created");
    } finally {
      detach();
      await events.shutdown();
      await boundary.dispose();
    }
  } finally {
    await process.dispose();
  }
}, 60_000);

test("detached native history cannot keep the Connector queue ahead of Stop", async () => {
  const process = await pinnedOpenCode();
  try {
    const boundary = await connectorBoundary(process);
    try {
      for (const loss of ["stream-close", "reconnect"] as const) {
        const sessionID = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
        await boundary.client.session.create({
          id: sessionID,
          location: { directory: "/workspace/project" },
          model: { providerID: "factory", id: buildModelID },
        });
        const read = await boundary.delayRead(loss);
        const history = read.client.message.list({ sessionID, limit: 100 }).then(
          () => true,
          () => false,
        );
        try {
          await read.detach();
          await boundary.client.session.interrupt(
            { sessionID },
            { signal: AbortSignal.timeout(2_000) },
          );
          expect(await history).toBe(false);
          expect((await process.control()).providerRequests).toBe(0);
        } finally {
          read.finish();
          await history;
        }
        expect(
          await boundary.client.message.list(
            { sessionID, limit: 100 },
            { signal: AbortSignal.timeout(2_000) },
          ),
        ).toMatchObject({ data: [] });
      }
    } finally {
      await boundary.dispose();
    }
  } finally {
    await process.dispose();
  }
}, 60_000);
