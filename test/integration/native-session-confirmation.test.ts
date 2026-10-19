import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";

test.each(["prepared", "confirmed", "recorded usage"] as const)(
  "native Session migration preserves %s history without inventing creation",
  async (history) => {
    const owned = await fixture();
    const migration = owned.database.coordination();
    try {
      if (history !== "confirmed")
        await owned.database.client`UPDATE factory.change_agent_session
          SET state='failed' WHERE change_id=${owned.changeID}`;
      if (history === "recorded usage") {
        const admission = createChangeAdmission(owned.database, buildModelID);
        const accepted = await admission.admit(owned.changeID, owned.userID, {
          kind: "change-prompt",
          commandId: crypto.randomUUID(),
          text: "Owned historical native Session, no inference.",
        });
        await owned.database.client`INSERT INTO factory.usage_operation(
          id,project_id,user_id,purpose,engine,provider,model,settled_at,outcome)
          VALUES(${"turn:" + accepted.turn.id},${owned.projectID},${owned.userID},
            'coding','opencode','openai',${buildModelID},now(),'failed')`;
      }
      await migration`ALTER TABLE factory.change_agent_session
        DROP COLUMN native_session_confirmed_at`;
      await migration`DELETE FROM factory.schema_migration WHERE version=3`;
      await migration.unsafe(
        await Bun.file(
          new URL(
            "../../packages/db/migrations/0003_native_session_confirmation.sql",
            import.meta.url,
          ),
        ).text(),
      );
      const [observed] = await owned.database.client<{ confirmed: boolean; session: string }[]>`
        SELECT native_session_confirmed_at IS NOT NULL AS confirmed,
          opencode_session_id AS session FROM factory.change_agent_session
        WHERE change_id=${owned.changeID}`;
      expect(observed).toEqual({
        confirmed: history !== "prepared",
        session: owned.sessionID,
      });
      expect(
        await owned.database.client`SELECT version FROM factory.schema_migration WHERE version=3`,
      ).toHaveLength(1);
      if (history !== "prepared")
        await expect(
          (async () => {
            await owned.database
              .client`UPDATE factory.change_agent_session SET opencode_session_id=NULL
              WHERE change_id=${owned.changeID}`;
          })(),
        ).rejects.toThrow("change_agent_native_session_confirmation");
      expect(owned.requests()).toBe(0);
    } finally {
      await migration.end({ timeout: 2 });
      await owned.dispose();
    }
  },
  30_000,
);
