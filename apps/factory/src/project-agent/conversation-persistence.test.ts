import { expect, spyOn, test } from "bun:test";
import { conversationDatabase } from "../../../../test/support/conversation-persistence";
import { createProjectAgentController } from "./controller";

test("research delegates locked command receipts and context inserts without changing admission or starting engines", async () => {
  for (const ticketMode of [undefined, "plan", "build"] as const) {
    const projectID = crypto.randomUUID();
    const ticketID = ticketMode ? crypto.randomUUID() : undefined;
    const userID = crypto.randomUUID();
    const conversationID = crypto.randomUUID();
    const commandID = crypto.randomUUID();
    let insertedID: string | undefined;
    let receipt: { id: string; conversationID: string; userID: string; kind: string } | undefined;
    let member = true;
    let engineCalls = 0;
    const fixture = conversationDatabase(
      ({ text, parameters }) => {
        if (text.startsWith("SELECT id FROM factory.ticket")) return [{ id: ticketID }];
        if (text.includes("pg_advisory_xact_lock")) return [];
        if (text.includes("FROM factory.ticket_conversation")) {
          return [
            {
              id: conversationID,
              projectId: projectID,
              ticketId: ticketID ?? null,
              mode: ticketMode ?? "investigate",
              version: 11,
            },
          ];
        }
        if (text.includes("FROM factory.conversation_context WHERE command_id"))
          return receipt ? [receipt] : [];
        if (text.startsWith("INSERT INTO factory.conversation_context")) {
          expect(parameters.slice(1, 4)).toEqual([conversationID, commandID, "research"]);
          expect(parameters.slice(5)).toEqual([
            "New conversation",
            userID,
            ticketMode === "build" ? "investigate" : "plan",
            null,
            null,
            null,
            false,
            null,
            "[]",
          ]);
          insertedID = String(parameters[0]);
          receipt = { id: insertedID, conversationID, userID, kind: "research" };
          return [];
        }
        throw new Error(`Unexpected research persistence query: ${text}`);
      },
      ({ text }) => {
        if (text.includes('"auth"."user"')) return [[userID]];
        if (text.includes('"factory"."account_access"')) return [[null, null]];
        if (text.includes('"factory"."project_membership"'))
          return member ? [["product-contributor", false]] : [];
        if (text.includes('"factory"."administrator"')) return [];
        if (text.includes('"factory"."project"')) return [[projectID]];
        throw new Error(`Unexpected research authority: ${text}`);
      },
    );
    const controller = createProjectAgentController(fixture.database, {
      async start() {
        engineCalls++;
        throw new Error("Research persistence cannot start Coding");
      },
    });
    const get = spyOn(controller, "get").mockResolvedValue(null);
    try {
      await controller.newConversation(projectID, ticketID, userID, commandID);
      expect(insertedID).toMatch(/^[a-f0-9-]{36}$/);
      expect(get).toHaveBeenLastCalledWith(projectID, ticketID, userID, insertedID);
      const count = fixture.statements.length;
      await controller.newConversation(projectID, ticketID, userID, commandID);
      expect(fixture.statements.slice(count).some(({ text }) => text.startsWith("INSERT"))).toBe(
        false,
      );
      if (!receipt) throw new Error("Missing research receipt");
      receipt.kind = "coding";
      await expect(
        controller.newConversation(projectID, ticketID, userID, commandID),
      ).rejects.toThrow("different input");
      member = false;
      await expect(
        controller.newConversation(projectID, ticketID, userID, crypto.randomUUID()),
      ).rejects.toMatchObject({ code: "not-found" });
      expect(engineCalls).toBe(0);
      expect(fixture.statements.some(({ text }) => text.startsWith("UPDATE"))).toBe(false);
      const inserts = fixture.statements.filter(({ text }) => text.startsWith("INSERT"));
      expect(inserts).toHaveLength(1);
      const insertIndex = fixture.statements.findIndex(({ text }) => text.startsWith("INSERT"));
      expect(fixture.statements[insertIndex - 1]?.text).toEndWith("FOR UPDATE");
    } finally {
      get.mockRestore();
      await controller.shutdown();
    }
  }
});
