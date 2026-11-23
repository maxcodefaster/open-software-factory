import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { createWorkspaceContainerFiles } from "../../apps/factory/src/workspace/container-files";
import { createWorkspaceSharing } from "../../apps/factory/src/workspace/sharing";
import { createWorkspaceTransferRoutes } from "../../apps/factory/src/workspace/transfer-routes";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import { utf8TextPage } from "../../packages/workspace-domain/src/text-page";
import { startSubstrateFixtureWorkspace, substrateFixture } from "../fixtures/substrate";

const sha256 = (content: Uint8Array) => createHash("sha256").update(content).digest("hex");

async function fileFixture() {
  const fixture = await substrateFixture();
  const { database, userID: owner, projectID: project, workspaceID, attemptID, hub } = fixture;
  const guest = crypto.randomUUID();
  await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${guest},'Files fixture',${`${guest}@factory.invalid`})`;
  await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${project},${guest},'developer',${owner})`;
  const runtime = await startSubstrateFixtureWorkspace(fixture);
  const actions: string[] = [];
  const published = new Map<string, Buffer>();
  const native = new Map<
    string,
    {
      id: string;
      path: string;
      bytes: number;
      version: string;
      nextOffset: number;
      complete: boolean;
      content: Buffer;
    }
  >();
  let loseBegin = false,
    loseCommit = false;
  let readReply: Record<string, unknown> | undefined;
  const parent = {
    data: { kind: "connector", role: "parent", attemptID, generation: 1 },
    close() {},
    send: () => 1,
  } as unknown as ServerWebSocket<RuntimeSocketData>;
  const child = {
    data: { kind: "connector", role: "child", attemptID, generation: 1 },
    close() {},
    send(value: string) {
      const request = JSON.parse(value) as { operationId: string; action: string; data: string };
      const input = JSON.parse(request.data);
      actions.push(request.action);
      let result: unknown;
      if (request.action === "file-context")
        result = {
          workspaceFolder: "/workspaces/project/services/python",
          checkoutFolder: "/workspaces/project",
          userID: 1000,
        };
      else if (request.action === "file-read") {
        const content = published.get(input.path) ?? Buffer.from("A€B");
        const version = sha256(content);
        if (input.version && input.version !== version)
          throw new Error("container file version changed");
        const page = utf8TextPage(content, input.offset, input.limit);
        const bytes = Buffer.from(page.content);
        result = readReply ?? {
          path: input.path,
          bytes: content.length,
          version,
          content: bytes.toString("base64"),
          offset: input.offset,
          nextOffset: input.offset + bytes.length,
          complete: page.nextOffset === null,
        };
      } else if (
        request.action === "file-upload-begin" ||
        request.action === "file-download-begin"
      ) {
        const content =
          request.action === "file-download-begin"
            ? (published.get(input.path) ?? Buffer.from("pinned-download"))
            : Buffer.alloc(0);
        native.set(input.id, {
          id: input.id,
          path: input.path,
          bytes: input.bytes ?? content.length,
          version: input.sha256 ?? sha256(content),
          nextOffset: 0,
          complete: false,
          content,
        });
        if (loseBegin) throw new Error("lost begin acknowledgement");
        const { content: _content, ...view } = native.get(input.id) ?? {};
        result = view;
      } else if (request.action === "file-release") {
        native.delete(input.id);
        result = { released: true };
      } else if (["file-mkdir", "file-delete", "file-rename"].includes(request.action))
        result = { path: input.path, bytes: 0, complete: true };
      else {
        const transfer = native.get(input.id);
        if (!transfer) throw new Error("native transfer no longer exists");
        if (request.action === "file-upload-chunk") {
          const bytes = Buffer.from(input.content, "base64");
          if (input.offset === transfer.content.length)
            transfer.content = Buffer.concat([transfer.content, bytes]);
          else if (
            !transfer.content.subarray(input.offset, input.offset + bytes.length).equals(bytes)
          )
            throw new Error("repeated chunk has different input");
          transfer.nextOffset = transfer.content.length;
        }
        if (request.action === "file-upload-commit") {
          if (
            sha256(transfer.content) !== transfer.version ||
            transfer.bytes !== transfer.content.length
          )
            throw new Error("checksum mismatch");
          transfer.complete = true;
          published.set(transfer.path, Buffer.from(transfer.content));
          if (loseCommit) throw new Error("lost commit acknowledgement");
        }
        const { content, ...view } = transfer;
        result =
          request.action === "file-download-chunk"
            ? {
                ...view,
                offset: input.offset,
                nextOffset: Math.min(content.length, input.offset + input.limit),
                complete: input.offset + input.limit >= content.length,
                content: content
                  .subarray(input.offset, input.offset + input.limit)
                  .toString("base64"),
              }
            : view;
      }
      queueMicrotask(() =>
        hub.message(
          child,
          JSON.stringify({
            type: "operation-response",
            operationId: request.operationId,
            action: request.action,
            data: JSON.stringify(result),
          }),
        ),
      );
      return 1;
    },
  } as ServerWebSocket<RuntimeSocketData>;
  hub.open(parent);
  hub.open(child);
  hub.message(
    child,
    JSON.stringify({
      type: "hello",
      role: "child",
      channels: [],
      commandCount: 0,
      terminalCount: 0,
      terminalBusy: 0,
      terminalRevision: 1,
    }),
  );
  const files = createWorkspaceContainerFiles(database, hub, runtime, "files-fixture");
  const sharing = createWorkspaceSharing(database, () => {});
  return {
    database,
    owner,
    guest,
    workspaceID,
    attemptID,
    files,
    sharing,
    actions,
    native,
    published,
    setReadReply(reply: Record<string, unknown> | undefined) {
      readReply = reply;
    },
    loseBegin() {
      loseBegin = true;
    },
    loseCommit() {
      loseCommit = true;
    },
    async dispose() {
      await files.close();
      hub.revoke(attemptID);
      await fixture.dispose();
    },
  };
}

test("container text pages reconstruct multibyte content, preserve byte cursors and reject changed versions", async () => {
  const f = await fileFixture();
  const input = { workspaceID: f.workspaceID, path: "/text", limit: 2 };
  try {
    const first = await f.files.read(f.owner, input);
    expect(first).toMatchObject({ content: "A", bytes: 5, nextOffset: 1 });
    const second = await f.files.read(f.owner, {
      ...input,
      offset: 1,
      limit: 3,
      version: first.version,
    });
    expect(second).toMatchObject({ content: "€", bytes: 5, nextOffset: 4, version: first.version });
    const last = await f.files.read(f.owner, {
      ...input,
      offset: 4,
      limit: 1,
      version: first.version,
    });
    expect(last).toMatchObject({
      content: "B",
      bytes: 5,
      nextOffset: null,
      version: first.version,
    });
    expect(first.content + second.content + last.content).toBe("A€B");
    expect(await f.files.read(f.owner, { ...input, offset: 5 })).toMatchObject({
      content: "",
      nextOffset: null,
      bytes: 5,
    });
    f.published.set("/empty", Buffer.alloc(0));
    expect(await f.files.read(f.owner, { ...input, path: "/empty" })).toMatchObject({
      content: "",
      nextOffset: null,
      bytes: 0,
    });
    for (const text of ["\ufeffA¢€😀B\ufeff", "�\x00é界🦊"]) {
      f.published.set(input.path, Buffer.from(text));
      for (const limit of [4, 5, 6, 7]) {
        let offset = 0;
        let content = "";
        const version = sha256(Buffer.from(text));
        for (;;) {
          const page = await f.files.read(f.owner, { ...input, offset, limit, version });
          const length = Buffer.byteLength(page.content);
          expect(length).toBeLessThanOrEqual(limit);
          expect(page.version).toBe(version);
          content += page.content;
          if (page.nextOffset === null) {
            expect(offset + length).toBe(page.bytes);
            break;
          }
          expect(page.nextOffset).toBe(offset + length);
          expect(page.nextOffset).toBeGreaterThan(offset);
          offset = page.nextOffset;
        }
        expect(content).toBe(text);
      }
    }
    f.published.set(input.path, Buffer.from("A€C"));
    await expect(
      f.files.read(f.owner, { ...input, offset: 4, limit: 1, version: first.version }),
    ).rejects.toMatchObject({ code: "conflict", message: "File changed between pages" });
  } finally {
    await f.dispose();
  }
}, 30000);

test("container text paging refuses split offsets, insufficient budgets and invalid native text or cursors", async () => {
  const f = await fileFixture();
  const input = { workspaceID: f.workspaceID, path: "/text", limit: 2 };
  try {
    await expect(f.files.read(f.owner, { ...input, offset: 2, limit: 3 })).rejects.toMatchObject({
      code: "invalid",
      message: "UTF-8 text page offset must be a character boundary",
    });
    await expect(f.files.read(f.owner, { ...input, offset: 1 })).rejects.toMatchObject({
      code: "invalid",
      message: "UTF-8 text page limit cannot fit the next character; increase limit",
    });
    const native = {
      path: input.path,
      bytes: 5,
      version: sha256(Buffer.from("A€B")),
      content: Buffer.from([0x41, 0xe2]).toString("base64"),
      offset: 0,
      nextOffset: 2,
      complete: false,
    };
    f.setReadReply(native);
    await expect(f.files.read(f.owner, input)).rejects.toMatchObject({
      code: "invalid",
      message: "UTF-8 text page contains invalid encoding; use a binary file transfer",
    });
    for (const reply of [
      { ...native, content: Buffer.from("A").toString("base64"), nextOffset: 2 },
      { ...native, content: Buffer.from("A€").toString("base64"), nextOffset: 4 },
      { ...native, content: "", nextOffset: 0 },
      { ...native, content: Buffer.from("A").toString("base64"), nextOffset: 1, complete: true },
    ]) {
      f.setReadReply(reply);
      await expect(f.files.read(f.owner, input)).rejects.toMatchObject({
        code: "unavailable",
        message: "Container text page has an invalid byte window",
      });
    }
    f.setReadReply(undefined);
    f.published.set(input.path, Buffer.from([0x41, 0xe2, 0x82]));
    await expect(f.files.read(f.owner, input)).rejects.toMatchObject({ code: "invalid" });
  } finally {
    await f.dispose();
  }
}, 30000);

test("container transfers retain exact intent, not file bytes, and never recreate uncertain uploads", async () => {
  const f = await fileFixture();
  const content = Buffer.from("private-file-bytes-must-not-be-in-history");
  const input = {
    requestID: crypto.randomUUID(),
    workspaceID: f.workspaceID,
    path: "/workspaces/project/artifact",
    direction: "upload" as const,
    bytes: content.length,
    sha256: sha256(content),
  };
  try {
    f.loseBegin();
    await expect(f.files.begin(f.owner, input)).rejects.toThrow("lost begin");
    expect((await f.files.begin(f.owner, input)).state).toBe("active");
    expect(f.actions.filter((a) => a === "file-upload-begin")).toHaveLength(1);
    await f.files.upload(f.owner, input.requestID, 0, content);
    f.loseCommit();
    await expect(f.files.commit(f.owner, input.requestID)).rejects.toThrow("lost commit");
    expect((await f.files.commit(f.owner, input.requestID)).state).toBe("committed");
    expect((await f.files.commit(f.owner, input.requestID)).state).toBe("committed");
    expect(f.actions.filter((a) => a === "file-upload-commit")).toHaveLength(1);
    await expect(f.files.begin(f.owner, { ...input, path: "/another-path" })).rejects.toThrow(
      "different input",
    );
    const [retained] = await f.database.client<
      { value: string }[]
    >`SELECT row_to_json(transfer)::text AS value FROM factory.workspace_file_transfer transfer WHERE id=${input.requestID}`;
    expect(retained?.value).not.toContain(content.toString());
    await f.files.release(f.owner, input.requestID);
    expect((await f.files.begin(f.owner, input)).state).toBe("released");
    expect(f.actions.filter((a) => a === "file-upload-begin")).toHaveLength(1);
  } finally {
    await f.dispose();
  }
}, 30000);

test("a lost native handle never turns an existing transfer into a new write", async () => {
  const f = await fileFixture();
  const input = {
    requestID: crypto.randomUUID(),
    workspaceID: f.workspaceID,
    path: "/artifact",
    direction: "upload" as const,
    bytes: 0,
    sha256: sha256(Buffer.alloc(0)),
  };
  try {
    await f.files.begin(f.owner, input);
    f.loseCommit();
    await expect(f.files.commit(f.owner, input.requestID)).rejects.toThrow("lost commit");
    f.native.clear();
    expect((await f.files.commit(f.owner, input.requestID)).state).toBe("uncertain");
    expect((await f.files.begin(f.owner, input)).state).toBe("uncertain");
    expect(f.actions.filter((a) => a === "file-upload-begin")).toHaveLength(1);
    expect(f.actions.filter((a) => a === "file-upload-commit")).toHaveLength(1);
  } finally {
    await f.dispose();
  }
}, 30000);

test("large files use bounded chunks and verify the assembled download without retaining bytes", async () => {
  const f = await fileFixture();
  const content = Buffer.alloc((3 << 20) + 17);
  for (let index = 0; index < content.length; index++) content[index] = index % 251;
  try {
    const upload = await f.files.begin(f.owner, {
      requestID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      path: "/workspaces/project/large.bin",
      direction: "upload",
      bytes: content.length,
      sha256: sha256(content),
    });
    for (let offset = 0; offset < content.length; offset += upload.chunkBytes)
      await f.files.upload(
        f.owner,
        upload.transferID,
        offset,
        content.subarray(offset, offset + upload.chunkBytes),
      );
    expect((await f.files.commit(f.owner, upload.transferID)).state).toBe("committed");
    await f.files.release(f.owner, upload.transferID);
    const download = await f.files.begin(f.owner, {
      requestID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      path: upload.path,
      direction: "download",
    });
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const chunk = await f.files.download(f.owner, download.transferID, offset);
      expect(chunk.content.length).toBeLessThanOrEqual(download.chunkBytes);
      chunks.push(chunk.content);
      offset = chunk.nextOffset;
      if (chunk.complete) break;
    }
    expect(sha256(Buffer.concat(chunks))).toBe(download.sha256 ?? "");
    expect(Buffer.concat(chunks).equals(content)).toBe(true);
    const [retained] = await f.database.client<
      { bytes: number }[]
    >`SELECT max(octet_length(result::text))::int AS bytes FROM factory.workspace_file_transfer`;
    expect(retained?.bytes ?? Infinity).toBeLessThan(1024);
    await f.database
      .client`UPDATE factory.workspace_file_transfer SET expires_at=now()-interval '1 second' WHERE id=${download.transferID}`;
    await expect(f.files.download(f.owner, download.transferID, 0)).rejects.toThrow("expired");
  } finally {
    await f.dispose();
  }
}, 30000);

test("container access rechecks sharing, preserves actor ownership and refuses explicit Stop", async () => {
  const f = await fileFixture();
  try {
    await f.sharing.decide(f.owner, {
      commandID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      userID: f.guest,
      permission: "observe",
      expectedVersion: 0,
    });
    await expect(f.files.context(f.guest, f.workspaceID)).rejects.toThrow("observation only");
    await expect(
      f.files.read(f.guest, { workspaceID: f.workspaceID, path: "/text", limit: 4 }),
    ).rejects.toThrow("observation only");
    await f.sharing.decide(f.owner, {
      commandID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      userID: f.guest,
      permission: "collaborate",
      expectedVersion: 1,
    });
    expect(await f.files.context(f.guest, f.workspaceID)).toEqual({
      workspaceFolder: "/workspaces/project/services/python",
      checkoutFolder: "/workspaces/project",
      userID: 1000,
    });
    expect(
      (await f.files.read(f.guest, { workspaceID: f.workspaceID, path: "/text", limit: 4 }))
        .content,
    ).toBe("A€");
    const download = await f.files.begin(f.guest, {
      requestID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      path: "/artifact",
      direction: "download",
    });
    await expect(f.files.download(f.owner, download.transferID, 0)).rejects.toThrow("not found");
    expect((await f.files.download(f.guest, download.transferID, 0)).content.toString()).toBe(
      "pinned-download",
    );
    await f.sharing.decide(f.owner, {
      commandID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      userID: f.guest,
      permission: null,
      expectedVersion: 2,
    });
    await expect(f.files.download(f.guest, download.transferID, 0)).rejects.toThrow(
      "Workspace not found",
    );
    await expect(
      f.files.read(f.guest, { workspaceID: f.workspaceID, path: "/text", limit: 4 }),
    ).rejects.toThrow("Workspace not found");
    const [attempt] = await f.database.client<
      { state: string }[]
    >`SELECT state FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    expect(attempt?.state).toBe("ready");
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${f.attemptID}`;
    const count = f.actions.length;
    await expect(f.files.context(f.owner, f.workspaceID)).rejects.toThrow(
      "Start this Workspace explicitly",
    );
    await expect(
      f.files.read(f.owner, { workspaceID: f.workspaceID, path: "/text", limit: 4 }),
    ).rejects.toThrow("Start this Workspace explicitly");
    expect(f.actions).toHaveLength(count);
  } finally {
    await f.dispose();
  }
}, 30000);

test("HTTP file chunks require header authentication and current scope without credentials in the URL", async () => {
  const f = await fileFixture();
  const base = "http://factory.invalid";
  const route = createWorkspaceTransferRoutes({
    origin: base,
    files: f.files,
    identity: {
      async mcpSession(request) {
        const token = request.headers.get("authorization");
        if (!token) throw new Error("No bearer token");
        return {
          userID: f.owner,
          sessionID: crypto.randomUUID(),
          clientID: "owned-client",
          scopes:
            token === "Bearer read-only" ? ["factory:read"] : ["factory:read", "factory:work"],
        };
      },
    },
  });
  try {
    const download = await f.files.begin(f.owner, {
      requestID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      path: "/artifact",
      direction: "download",
    });
    const url = `${base}/api/workspace-transfers/${download.transferID}`;
    expect((await route(new Request(url))).status).toBe(401);
    expect((await route(new Request(`${url}?token=ignored`))).status).toBe(401);
    expect(
      (await route(new Request(url, { headers: { authorization: "Bearer read-only" } }))).status,
    ).toBe(403);
    expect(
      (
        await route(
          new Request(url, {
            headers: { authorization: "Bearer owned", origin: "https://foreign.invalid" },
          }),
        )
      ).status,
    ).toBe(403);
    const response = await route(
      new Request(`${url}?offset=0&limit=6`, { headers: { authorization: "Bearer owned" } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-factory-sha256")).toBe(download.sha256);
    expect(response.headers.get("x-factory-next-offset")).toBe("6");
    expect(await response.text()).toBe("pinned");
    expect(
      (
        await route(
          new Request(`${url}?limit=999999`, { headers: { authorization: "Bearer owned" } }),
        )
      ).status,
    ).toBe(400);
  } finally {
    await f.dispose();
  }
}, 30000);

test("file mutation IDs do not replay and an old transfer cannot wake replacement compute", async () => {
  const f = await fileFixture();
  try {
    const mutation = {
      requestID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      path: "/old-file",
      action: "delete" as const,
    };
    const first = await f.files.mutate(f.owner, mutation);
    expect(await f.files.mutate(f.owner, mutation)).toEqual(first);
    expect(f.actions.filter((action) => action === "file-delete")).toHaveLength(1);
    await expect(f.files.mutate(f.owner, { ...mutation, path: "/another-file" })).rejects.toThrow(
      "different input",
    );
    const download = await f.files.begin(f.owner, {
      requestID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      path: "/artifact",
      direction: "download",
    });
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${f.attemptID}`;
    const successorID = runtimeIdentity(f.workspaceID, 2).attemptID;
    // Controlled state for stale-transfer fencing, not a native Stop/Start proof.
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,
        parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
        SELECT ${successorID},project_id,workspace_id,2,revision,'create-intended',
          'replacement-parent','replacement-child',now(),created_by
        FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
      await sql`INSERT INTO factory.substrate_binding(runtime_attempt_id,atespace,actor_name,intent)
        VALUES(${successorID},${`fa-${successorID.replaceAll("-", "")}`},
          ${`runtime-${successorID.replaceAll("-", "")}`},'{}')`;
      await sql`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${successorID}`;
    });
    const before = f.actions.length;
    await expect(f.files.download(f.owner, download.transferID, 0)).rejects.toThrow(
      "cannot wake replacement compute",
    );
    expect(f.actions).toHaveLength(before);
  } finally {
    await f.dispose();
  }
}, 30000);
