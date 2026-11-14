import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  cancelQueuedOpenCodeInput,
  confirmEmptyOpenCodeSession,
  confirmSettledOpenCodeInput,
  interruptOpenCodeSession,
} from "../../apps/factory/src/agent/opencode-client";
import { buildModelID } from "../fixtures/change-agent-turns";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

test.each([false, true])(
  "Stop settles queued descendants without inference, preserves unrelated input and survives process restart: other root input=%s",
  async (otherRootInput) => {
    const process = await pinnedOpenCode();
    const id = () => `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
    const root = id(),
      child = id(),
      grandchild = id(),
      foreign = id();
    const input = () => `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`;
    const rootInput = input(),
      childInput = input(),
      grandchildInput = input();
    const other = input(),
      foreignInput = input();
    const draft = resolve(process.scratch, "project", "retained-draft.txt");
    const client = process.client;
    try {
      for (const [sessionID, parentID] of [
        [root, undefined],
        [child, root],
        [grandchild, child],
        [foreign, undefined],
      ] as const) {
        await client.session.create({
          id: sessionID,
          title: "Owned queued Stop proof",
          ...(parentID ? { parentID } : {}),
          location: { directory: "/workspace/project" },
          model: { providerID: "factory", id: buildModelID },
        });
        if (sessionID !== root) await client.session.switchAgent({ sessionID, agent: "build" });
      }
      await writeFile(draft, "Retain the developer's unpublished source.\n");
      for (const [sessionID, promptID] of [
        [child, childInput],
        [grandchild, grandchildInput],
        [foreign, foreignInput],
      ] as const)
        await client.session.prompt({
          sessionID,
          id: promptID,
          text: "Queued input must not run",
          delivery: "queue",
          resume: false,
        });
      // An otherwise empty root cannot prove Stop while a descendant retains work.
      expect((await client.message.list({ sessionID: root, limit: 1 })).data).toEqual([]);
      expect(await confirmEmptyOpenCodeSession(client, root)).toBe(false);
      expect(await confirmSettledOpenCodeInput(client, root, rootInput)).toBe(false);
      await client.session.switchAgent({ sessionID: root, agent: "build" });
      await client.session.prompt({
        sessionID: root,
        id: rootInput,
        text: "Stop this exact root input",
        delivery: "queue",
        resume: false,
      });
      if (otherRootInput)
        await client.session.prompt({
          sessionID: root,
          id: other,
          text: "Do not discard another root input",
          delivery: "queue",
          resume: false,
        });
      expect((await process.control()).providerRequests).toBe(0);
      expect(await interruptOpenCodeSession(client, root)).toBe("interrupted");
      expect(await cancelQueuedOpenCodeInput(client, root, rootInput)).toBe(!otherRootInput);
      expect(await client.session.inbox.list({ sessionID: child })).toEqual([]);
      expect(await client.session.inbox.list({ sessionID: grandchild })).toEqual([]);
      expect(
        (await client.session.inbox.list({ sessionID: foreign })).map((item) => item.id),
      ).toEqual([foreignInput]);
      expect((await client.session.inbox.list({ sessionID: root })).map((item) => item.id)).toEqual(
        otherRootInput ? [other] : [],
      );
      await process.control("/kill", "POST");
      await process.control("/restart", "POST");
      await observe(
        () =>
          client.server
            .info()
            .then(() => true)
            .catch(() => false),
        (value) => value,
      );
      expect(await client.session.inbox.list({ sessionID: child })).toEqual([]);
      expect(await client.session.inbox.list({ sessionID: grandchild })).toEqual([]);
      expect(await readFile(draft, "utf8")).toContain("unpublished source");
      expect((await process.control()).providerRequests).toBe(0);
      if (!otherRootInput) {
        const next = input();
        await client.session.prompt({
          sessionID: root,
          id: next,
          text: "A new explicitly commissioned input. Reply without tools.",
          delivery: "queue",
          resume: true,
        });
        await observe(process.control, (value) => value.providerRequests === 1);
        await process.control("/release", "POST");
        await observe(
          () => client.session.active(),
          (active) => !Object.hasOwn(active, root),
        );
        expect((await process.control()).providerRequests).toBe(1);
        expect(await client.session.inbox.list({ sessionID: child })).toEqual([]);
        expect(await client.session.inbox.list({ sessionID: grandchild })).toEqual([]);
      }
    } finally {
      await process.dispose();
    }
  },
  60_000,
);
