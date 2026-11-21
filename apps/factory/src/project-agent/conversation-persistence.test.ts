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
    const fixture = conversationDatabase(
      ({ text }) => {
        throw new Error(`Unexpected raw research persistence query: ${text}`);
      },
      ({ text, parameters }) => {
        if (text.includes('from "factory"."ticket"')) return [[ticketID]];
        if (text.includes("pg_advisory_xact_lock")) return [];
        if (text.includes('from "factory"."ticket_conversation"')) {
          if (text.endsWith("for update")) return [[conversationID]];
          return [
            [conversationID, projectID, ticketID ?? null, ticketMode ?? "investigate", "11", null],
          ];
        }
        if (text.startsWith("select") && text.includes('from "factory"."conversation_context"'))
          return receipt
            ? [[receipt.id, receipt.conversationID, receipt.userID, receipt.kind, null, null]]
            : [];
        if (text.startsWith('insert into "factory"."conversation_context"')) {
          expect(parameters.slice(1, 4)).toEqual([conversationID, commandID, "research"]);
          expect(parameters[4]).toBe(ticketMode === "build" ? "investigate" : "plan");
          expect(parameters.slice(5)).toEqual([
            conversationID,
            "New conversation",
            userID,
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
        if (text.includes('"auth"."user"')) return [[userID]];
        if (text.includes('"factory"."account_access"')) return [[null, null]];
        if (text.includes('"factory"."project_membership"'))
          return member ? [["product-contributor", false]] : [];
        if (text.includes('"factory"."administrator"')) return [];
        if (text.includes('"factory"."project"')) return [[projectID]];
        throw new Error(`Unexpected research authority: ${text}`);
      },
    );
    const controller = createProjectAgentController(fixture.database);
    const get = spyOn(controller, "get").mockResolvedValue(null);
    try {
      await controller.newConversation(projectID, ticketID, userID, commandID);
      expect(insertedID).toMatch(/^[a-f0-9-]{36}$/);
      expect(get).toHaveBeenLastCalledWith(projectID, ticketID, userID, insertedID);
      const count = fixture.statements.length;
      await controller.newConversation(projectID, ticketID, userID, commandID);
      expect(fixture.statements.slice(count).some(({ text }) => text.startsWith("insert"))).toBe(
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
      expect(fixture.statements.some(({ text }) => text.startsWith("update"))).toBe(false);
      const inserts = fixture.statements.filter(({ text }) => text.startsWith("insert"));
      expect(inserts).toHaveLength(1);
      const insertIndex = fixture.statements.findIndex(({ text }) => text.startsWith("insert"));
      expect(fixture.statements[insertIndex - 1]?.text).toEndWith("for update");
    } finally {
      get.mockRestore();
      await controller.shutdown();
    }
  }
});
