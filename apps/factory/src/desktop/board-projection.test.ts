import { expect, test } from "bun:test";

test("Board projections initialize inside a reactive computation and update prerequisites", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=browser",
      "--no-env-file",
      "-e",
      `
      import assert from "node:assert/strict";
      import { createRoot, createMemo, createSignal, flush } from "solid-js";
      import { createBoardProjection } from "./apps/factory/src/desktop/board-projection";
      const empty = { data: () => [], completeness: () => "complete", error: () => undefined, retry() {} };
      createRoot((dispose) => {
        const [tickets, setTickets] = createSignal([{ id: "prerequisite", title: "First", state: "inbox" }]);
        const [edges, setEdges] = createSignal([]);
        const [changes, setChanges] = createSignal([]);
        const view = createMemo(() => createBoardProjection({
          changes, dependencies: { ...empty, data: edges }, attempts: () => [],
          projects: empty, selectedProjectID: () => undefined, projectSearchQuery: () => "",
          tickets: { ...empty, data: tickets }, ticketLimit: () => 200, history: empty,
          historyLimit: () => 50, prerequisiteTickets: empty, foundTickets: empty,
          trashTickets: empty, detail: () => undefined, epics: empty, boardHistoryOpen: () => false,
        }));
        const projection = view();
        assert.deepEqual(projection.blockersFor("next"), []);
        setEdges([{ ticketId: "next", prerequisiteId: "prerequisite" }]);
        flush();
        assert.equal(view(), projection);
        assert.equal(projection.blockersFor("next")[0].title, "First");
        setTickets([{ id: "prerequisite", title: "Finished", state: "done" }]);
        setChanges([{ ticketId: "prerequisite", state: "delivered", verificationState: "succeeded",
          mergeState: "succeeded", promotionState: "succeeded" }]);
        flush();
        assert.deepEqual(projection.blockersFor("next"), []);
        assert.equal(projection.prerequisitesFor("next")[0].title, "Finished");
        dispose();
      });
      `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [status, error] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  expect(error).toBe("");
  expect(status).toBe(0);
});
