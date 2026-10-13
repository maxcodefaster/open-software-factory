import { expect, test } from "bun:test";
import { decodeOpenCodeAdmission } from "../../apps/factory/src/agent/opencode-client";
import { buildModelID } from "../fixtures/change-agent-turns";
import { connectorBoundary } from "../fixtures/connector-boundary";
import { pinnedOpenCode } from "../fixtures/pinned-opencode";

test("Connector interruption follows native prompt admission despite response/control loss", async () => {
  const process = await pinnedOpenCode();
  try {
    const boundary = await connectorBoundary(process);
    try {
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
    } finally {
      await boundary.dispose();
    }
  } finally {
    await process.dispose();
  }
}, 60_000);
