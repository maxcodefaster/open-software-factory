import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { createWorkspaceContainerFiles } from "../../apps/factory/src/workspace/container-files";
import { createWorkspaceSharing } from "../../apps/factory/src/workspace/sharing";
import { createWorkspaceTransferRoutes } from "../../apps/factory/src/workspace/transfer-routes";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { personalWorkspaceIdentity } from "../../packages/workspace-domain/src/workspace";
import { factoryProcess } from "../fixtures/factory-process";
import { installOwnedRuntimeConfiguration } from "../fixtures/runtime-configuration";

const sha256 = (content: Uint8Array) => createHash("sha256").update(content).digest("hex");

async function fileFixture() {
  const restore = installOwnedRuntimeConfiguration();
  const process = await factoryProcess();
  const database = process.connect();
  const owner = crypto.randomUUID(),
    guest = crypto.randomUUID(),
    project = crypto.randomUUID();
  const workspaceID = personalWorkspaceIdentity(project, owner).workspaceID;
  const attemptID = crypto.randomUUID();
  for (const id of [owner, guest])
    await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Files fixture',${`${id}@factory.invalid`})`;
  await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
    VALUES(${project},${`files-${project}`},'Container files','https://github.com/example/project','main','.devcontainer/devcontainer.json',${owner})`;
  for (const id of [owner, guest])
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${project},${id},'developer',${owner})`;
  await database.client`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
    VALUES(${workspaceID},${project},'personal',${owner},'main',${"a".repeat(40)},${owner})`;
  await database.client`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
    VALUES(${attemptID},${project},${workspaceID},1,${"a".repeat(40)},'ready','owned-parent','owned-child',now(),${owner})`;
  const hub = new RuntimeHub(async () => {});
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
        result = { workspaceFolder: "/workspaces/project", userID: 1000 };
      else if (request.action === "file-upload-begin" || request.action === "file-download-begin") {
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
  const runtime = createRuntimeController(database, hub, "files-fixture", {
    async prepareExecution() {
      throw new Error("This proof must not create compute");
    },
  });
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
    loseBegin() {
      loseBegin = true;
    },
    loseCommit() {
      loseCommit = true;
    },
    async dispose() {
      await files.close();
      hub.revoke(attemptID);
      await database.client.end({ timeout: 2 });
      await process.dispose();
      restore();
    },
  };
}

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
    await f.sharing.decide(f.owner, {
      commandID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      userID: f.guest,
      permission: "collaborate",
      expectedVersion: 1,
    });
    expect(await f.files.context(f.guest, f.workspaceID)).toEqual({
      workspaceFolder: "/workspaces/project",
      userID: 1000,
    });
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
    await f.database
      .client`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
      SELECT ${crypto.randomUUID()},project_id,workspace_id,2,revision,'paused','replacement-parent','replacement-child',now(),created_by
      FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    const before = f.actions.length;
    await expect(f.files.download(f.owner, download.transferID, 0)).rejects.toThrow(
      "cannot wake replacement compute",
    );
    expect(f.actions).toHaveLength(before);
  } finally {
    await f.dispose();
  }
}, 30000);
