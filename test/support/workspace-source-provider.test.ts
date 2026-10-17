import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import URI from "../../deploy/theia-ide/node_modules/@theia/core/lib/common/uri";
import { FileOperationError } from "../../deploy/theia-ide/node_modules/@theia/filesystem/lib/common/files";
// Exercise the extension compiled by its pinned TypeScript build. Theia's
// published const enums have no runtime exports for Bun's isolated transpiler.
import {
  SourceResponseError,
  FactorySourceClient,
  type SourceChange,
  type SourceTransport,
} from "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-source-client";
import {
  FactoryWorkspaceFiles,
  workspaceResource,
} from "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-workspace-files";

test.each([401, 403, 404, 503])(
  "source watch closes rejected access %s without a native watcher-capacity warning",
  async (status) => {
    const original = globalThis.EventSource;
    let events: { onerror?: () => void; closed: boolean } | undefined;
    class OwnedEvents {
      onerror?: () => void;
      onmessage?: (event: { data: string }) => void;
      closed = false;
      constructor() {
        events = this;
      }
      close() {
        this.closed = true;
      }
    }
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: OwnedEvents });
    const states: Array<boolean | undefined> = [];
    let close: (() => void) | undefined;
    try {
      const client = new FactorySourceClient(new URL("http://owned.invalid/editor/"), async () =>
        Response.json({ error: "Owned unavailable access" }, { status }),
      );
      close = client.watch(
        "workspace-a",
        () => {},
        (retrying) => states.push(retrying),
      );
      events?.onerror?.();
      await Bun.sleep(0);
      expect(states).toEqual(status === 503 ? [true] : [true, false]);
      expect(events?.closed).toBe(status !== 503);
    } finally {
      close?.();
      Object.defineProperty(globalThis, "EventSource", { configurable: true, value: original });
    }
  },
);

function sourceFixture() {
  const documents = new Map<string, string>();
  const writes: Array<{ workspaceID: string; body: Readonly<Record<string, unknown>> }> = [];
  const watchers = new Map<string, (event: SourceChange) => void>();
  const disconnects = new Map<string, () => void>();
  let subscriptions = 0;
  let closes = 0;
  const version = (content: string) => createHash("sha256").update(content).digest("hex");
  const file = (content: string) => ({
    kind: "file",
    size: Buffer.byteLength(content),
    mtime: 100,
    ctime: 100,
    content: Buffer.from(content).toString("base64"),
    version: version(content),
  });
  const transport: SourceTransport = {
    async request(workspaceID, operation, body) {
      const path = String(body["path"]);
      const key = `${workspaceID}/${path}`;
      if (operation === "write") {
        writes.push({ workspaceID, body });
        const current = documents.get(key);
        if (
          (current !== undefined && body["version"] !== version(current)) ||
          (current === undefined && body["version"] !== "")
        )
          throw new SourceResponseError(409);
        const saved = Buffer.from(String(body["content"]), "base64").toString();
        documents.set(key, saved);
        return file(saved);
      }
      if (!documents.has(key)) throw new SourceResponseError(404);
      return file(documents.get(key) ?? "");
    },
    watch(workspaceID, changed, disconnected) {
      subscriptions++;
      watchers.set(workspaceID, changed);
      disconnects.set(workspaceID, disconnected);
      return () => {
        closes++;
        watchers.delete(workspaceID);
        disconnects.delete(workspaceID);
      };
    },
  };
  return {
    documents,
    writes,
    watchers,
    disconnects,
    provider: new FactoryWorkspaceFiles(transport),
    subscriptions: () => subscriptions,
    closes: () => closes,
  };
}

describe("pinned Theia Workspace provider", () => {
  test("directory metadata is consumed once by Explorer and source changes invalidate it", async () => {
    const calls: string[] = [];
    let changed: ((event: SourceChange) => void) | undefined;
    let mtime = 100;
    const provider = new FactoryWorkspaceFiles({
      async request(_workspaceID, operation) {
        calls.push(operation);
        const metadata = { kind: "file", size: 4, mtime, ctime: 100 };
        return operation === "list" ? [{ name: "app.ts", ...metadata }] : metadata;
      },
      watch(_workspaceID, callback) {
        changed = callback;
        return () => {};
      },
    });
    const root = new URI("factory-workspace://workspace-a/");
    const file = root.resolve("app.ts");
    const watch = provider.watch(root, { recursive: true, excludes: [] });
    await provider.readdir(root);
    expect((await provider.stat(file)).mtime).toBe(100);
    expect(calls).toEqual(["list"]);
    await provider.stat(file);
    expect(calls).toEqual(["list", "stat"]);
    await provider.readdir(root);
    mtime = 200;
    changed?.({ path: "app.ts", kind: "updated" });
    expect((await provider.stat(file)).mtime).toBe(200);
    expect(calls.at(-1)).toBe("stat");
    watch.dispose();
    provider.dispose();
  });

  test("retains Workspace-qualified source identity through another Workspace read", async () => {
    const fixture = sourceFixture();
    const original = new URI("factory-workspace://workspace-a/app.ts");
    const alternate = new URI("factory-workspace://workspace-b/app.ts");
    fixture.documents.set("workspace-a/app.ts", "a");
    fixture.documents.set("workspace-b/app.ts", "b");
    expect(new TextDecoder().decode(await fixture.provider.readFile(original))).toBe("a");
    expect(new TextDecoder().decode(await fixture.provider.readFile(alternate))).toBe("b");
    await fixture.provider.writeFile(original, new TextEncoder().encode("dirty a"), {
      create: true,
      overwrite: true,
    });
    expect(fixture.writes[0]?.workspaceID).toBe("workspace-a");
    expect(fixture.documents.get("workspace-a/app.ts")).toBe("dirty a");
    expect(fixture.documents.get("workspace-b/app.ts")).toBe("b");
    fixture.provider.dispose();
  });

  test("metadata refresh cannot authorize a stale buffer save", async () => {
    const fixture = sourceFixture();
    const resource = new URI("factory-workspace://workspace-a/app.ts");
    fixture.documents.set("workspace-a/app.ts", "original");
    await fixture.provider.readFile(resource);
    fixture.documents.set("workspace-a/app.ts", "runtime edit");
    await fixture.provider.stat(resource);
    try {
      await fixture.provider.writeFile(resource, new TextEncoder().encode("dirty human edit"), {
        create: true,
        overwrite: true,
      });
      throw new Error("stale save succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(FileOperationError);
      expect((error as FileOperationError).fileOperationResult).toBe(3); // Theia 1.76 FILE_MODIFIED_SINCE.
    }
    expect(fixture.documents.get("workspace-a/app.ts")).toBe("runtime edit");
    fixture.provider.dispose();
  });

  test("shares one event stream per Workspace and retains subscriptions until last dispose", () => {
    const fixture = sourceFixture();
    const changes: string[] = [];
    fixture.provider.onDidChangeFile((events) =>
      changes.push(...events.map((event) => event.resource.toString())),
    );
    const options = { recursive: true, excludes: [] };
    const first = fixture.provider.watch(new URI("factory-workspace://workspace-a/"), options);
    const second = fixture.provider.watch(new URI("factory-workspace://workspace-a/src"), options);
    const alternate = fixture.provider.watch(new URI("factory-workspace://workspace-b/"), options);
    expect(fixture.subscriptions()).toBe(2);
    fixture.watchers.get("workspace-a")?.({ kind: "updated", path: "app.ts" });
    expect(changes).toEqual(["factory-workspace://workspace-a/app.ts"]);
    first.dispose();
    first.dispose();
    expect(fixture.closes()).toBe(0);
    second.dispose();
    expect(fixture.closes()).toBe(1);
    alternate.dispose();
    expect(fixture.closes()).toBe(2);
    fixture.provider.dispose();
  });

  test("rejects cross-Workspace moves and protected source paths before dispatch", async () => {
    const fixture = sourceFixture();
    for (const identity of [
      "file:///etc/passwd",
      "factory-workspace://workspace-a/.git/config",
      "factory-workspace://workspace-a/a/../b",
      "factory-workspace://workspace-a/app.ts?other=1",
    ]) {
      expect(() => workspaceResource(new URI(identity))).toThrow();
    }
    await expect(
      fixture.provider.rename(
        new URI("factory-workspace://workspace-a/app.ts"),
        new URI("factory-workspace://workspace-b/app.ts"),
        { overwrite: false },
      ),
    ).rejects.toThrow();
    expect(fixture.writes).toHaveLength(0);
    fixture.provider.dispose();
  });

  test("reconnect reconciliation refreshes observed files without resetting their save versions", async () => {
    const fixture = sourceFixture();
    const resource = new URI("factory-workspace://workspace-a/app.ts");
    fixture.documents.set("workspace-a/app.ts", "original");
    await fixture.provider.readFile(resource);
    const changed: string[] = [];
    let errors = 0;
    const connections: ReadonlyMap<string, boolean>[] = [];
    fixture.provider.onWatchConnectionChanged((value) => connections.push(value));
    fixture.provider.onDidChangeFile((events) =>
      changed.push(...events.map((event) => event.resource.toString())),
    );
    fixture.provider.onFileWatchError(() => errors++);
    const watcher = fixture.provider.watch(new URI("factory-workspace://workspace-a/"), {
      recursive: true,
      excludes: [],
    });
    fixture.disconnects.get("workspace-a")?.();
    expect(errors).toBe(0);
    expect(connections.at(-1)?.get("workspace-a")).toBe(true);
    fixture.documents.set("workspace-a/app.ts", "runtime edit");
    fixture.watchers.get("workspace-a")?.({ kind: "resync", path: "" });
    expect(connections.at(-1)?.size).toBe(0);
    expect(changed).toEqual(["factory-workspace://workspace-a/", resource.toString()]);
    expect(errors).toBe(0);
    await expect(
      fixture.provider.writeFile(resource, new TextEncoder().encode("dirty human edit"), {
        create: true,
        overwrite: true,
      }),
    ).rejects.toBeInstanceOf(FileOperationError);
    expect(fixture.documents.get("workspace-a/app.ts")).toBe("runtime edit");
    watcher.dispose();
    fixture.provider.dispose();
  });
});
