import { expect, test } from "bun:test";
import { createChangeController } from "../../apps/factory/src/change/controller";
import { fixture } from "../fixtures/change-agent-turns";

test.each([
  "create-intended",
  "starting",
  "ready",
  "stop-intended",
  "stopping",
  "cleanup-failed",
  "failed",
  "stopped",
])(
  "Change recovery does not commission compute when its recorded attempt is %s",
  async (state) => {
    const owned = await fixture();
    const previous = new Map<string, string | undefined>();
    const configuration = {
      FACTORY_FORGEJO_API_URL: "https://unused-owned-forge.invalid/api/v1/",
      FACTORY_FORGEJO_TOKEN: "unused-owned-recovery-token",
      FACTORY_FORGEJO_OWNER: "owned",
    };
    let starts = 0;
    try {
      for (const [key, value] of Object.entries(configuration)) {
        previous.set(key, process.env[key]);
        process.env[key] = value;
      }
      await owned.database
        .client`UPDATE factory.change SET state='starting' WHERE id=${owned.changeID}`;
      await owned.database
        .client`UPDATE factory.runtime_attempt SET state=${state}::factory.runtime_attempt_state WHERE id=${owned.attemptID}`;
      const runtime = {
        startPersisted: async () => {
          starts++;
          return null;
        },
        stop: async () => null,
      };
      const changes = createChangeController(owned.database, runtime);
      await changes.recover();
      await changes.recover();
      expect(starts).toBe(0);
      expect(owned.requests()).toBe(0);
      const rows = await owned.database.client`
      SELECT id,generation::int AS generation,state FROM factory.runtime_attempt WHERE project_id=${owned.projectID}`;
      expect([...rows]).toEqual([{ id: owned.attemptID, generation: 1, state }]);
    } finally {
      await owned.dispose();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
  30_000,
);
