import { expect, test } from "bun:test";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import { startSubstrateFixtureWorkspace, substrateFixture } from "../fixtures/substrate";

test("native Source rechecks slow uploads, orders revocation after writes and closes retained watches", async () => {
  const f = await substrateFixture();
  const runtime = await startSubstrateFixtureWorkspace(f);
  const source = createSubstrateSources(f.database, f.hub);
  const controller = createWorkspaceSourceController(f.database, f.hub, source);
  const finishWrite = Promise.withResolvers<void>();
  const writeStarted = Promise.withResolvers<void>();
  let calls = 0;
  let watchClosed = false;
  let pending: Promise<unknown> | undefined;
  try {
    const uid = (await runtime.get(f.attemptID))?.native?.actorUID;
    if (!uid) throw new Error("Native Source Actor is missing");
    await source.attach(f.workspaceID, uid, f.database.client);
    await f.database.client`UPDATE factory.runtime_attempt SET state='ready',ready_at=now()
      WHERE id=${f.attemptID}`;
    f.hub.sourceConnected = () => true;
    f.hub.request = async (_attempt, _channel, request, path) => {
      calls++;
      if (path.endsWith("/fence")) return Response.json({ confirmed: true });
      if (path.endsWith("/write")) {
        writeStarted.resolve();
        await finishWrite.promise;
        return Response.json({ saved: true });
      }
      if (path.endsWith("/events"))
        return new Response(
          new ReadableStream<Uint8Array>({
            start(target) {
              target.enqueue(new TextEncoder().encode('data: {"kind":"resync","path":""}\n\n'));
              request.signal.addEventListener(
                "abort",
                () => {
                  watchClosed = true;
                  target.close();
                },
                { once: true },
              );
            },
          }),
        );
      return Response.json({ content: "aHVtYW4=" });
    };
    let upload: ReadableStreamDefaultController<Uint8Array> | undefined;
    const slowWrite = controller.forward(
      f.workspaceID,
      f.userID,
      "write",
      new Request("https://factory.test/write", {
        method: "POST",
        body: new ReadableStream<Uint8Array>({
          start(target) {
            upload = target;
          },
        }),
      }),
    );
    const refused = slowWrite.then(
      () => "unexpected admission",
      (error: Error) => error.message,
    );
    await f.database.client`UPDATE factory.project_membership SET role='product-contributor'
      WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    upload?.enqueue(new TextEncoder().encode('{"path":"app.ts"}'));
    upload?.close();
    expect(await refused).toContain("Developer access required");
    expect(calls).toBe(0);
    await f.database.client`UPDATE factory.project_membership SET role='developer'
      WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
    const watch = await controller.forward(
      f.workspaceID,
      f.userID,
      "events",
      new Request("https://factory.test/events"),
    );
    const reader = watch.body?.getReader();
    if (!reader) throw new Error("Native Source watch is missing");
    expect((await reader.read()).done).toBe(false);
    await controller.reconcileUserAccess(f.userID);
    expect(watchClosed).toBe(false);
    const write = controller.forward(
      f.workspaceID,
      f.userID,
      "write",
      new Request("https://factory.test/write", {
        method: "POST",
        body: '{"path":"app.ts"}',
      }),
    );
    pending = write;
    await writeStarted.promise;
    let revoked = false;
    const revoke = (async () => {
      await f.database.client`UPDATE factory.project_membership SET role='product-contributor'
        WHERE project_id=${f.projectID} AND user_id=${f.userID}`;
      revoked = true;
      await controller.reconcileUserAccess(f.userID);
    })();
    await Bun.sleep(50);
    expect(revoked).toBe(false);
    finishWrite.resolve();
    expect((await write).status).toBe(200);
    await revoke;
    expect(watchClosed).toBe(true);
    expect((await reader.read()).done).toBe(true);
    const before = calls;
    await expect(
      controller.forward(
        f.workspaceID,
        f.userID,
        "read",
        new Request("https://factory.test/read", {
          method: "POST",
          body: '{"path":"app.ts"}',
        }),
      ),
    ).rejects.toThrow("Developer access required");
    expect(calls).toBe(before);
  } finally {
    finishWrite.resolve();
    await pending?.catch(() => {});
    await controller.close();
    await f.dispose();
  }
}, 30_000);
