import { expect, test } from "bun:test";
import URI from "../../deploy/theia-ide/node_modules/@theia/core/lib/common/uri";
import { FileStat } from "../../deploy/theia-ide/node_modules/@theia/filesystem/lib/common/files";
import { FactoryWorkspaceLabels } from "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-workspace-labels";
import {
  FactorySourceClient,
  SourceResponseError,
} from "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-source-client";

test("Workspace names and file captions retain their original immutable source identity", async () => {
  const client = {
    async presentation(workspaceID: string) {
      return { workspaceID, label: `Ticket · ${workspaceID === "one" ? "First" : "Second"}` };
    },
  } as FactorySourceClient;
  const labels = new FactoryWorkspaceLabels(client);
  const first = new URI("factory-workspace://one/");
  const originalFile = first.resolve("src/app.ts");
  const second = new URI("factory-workspace://two/");
  expect(labels.getName(first)).toBe("Source · one");
  await labels.prepare("one");
  await labels.prepare("two");
  expect(labels.getName(first)).toBe("Ticket · First");
  expect(labels.getName(second)).toBe("Ticket · Second");
  expect(labels.canHandle(FileStat.dir(first))).toBeGreaterThan(10);
  expect(labels.getName(FileStat.dir(first))).toBe("Ticket · First");
  expect(labels.getName({ kind: "uriIconReference", id: "folder", uri: first })).toBe(
    "Ticket · First",
  );
  expect(labels.getName(originalFile)).toBeUndefined();
  expect(labels.getLongName(originalFile)).toBe("Ticket · First/src/app.ts");
  expect(labels.getDetails(originalFile)).toBe("Ticket · First");
  expect(labels.canHandle(new URI("file:///src/app.ts"))).toBe(0);
  expect(originalFile.toString()).toBe("factory-workspace://one/src/app.ts");
});

test("a display-name outage preserves the exact source identity rather than blocking files", async () => {
  const labels = new FactoryWorkspaceLabels({
    async presentation() {
      throw new SourceResponseError(503);
    },
  } as unknown as FactorySourceClient);
  await labels.prepare("one");
  expect(labels.getName(new URI("factory-workspace://one/"))).toBe("Source · one");
});

test("Workspace presentation is a scoped read and rejects mismatched or empty identities", async () => {
  const root = new URL("https://editor.invalid/editor/owned/1/");
  const expected = "11111111-1111-4111-8111-111111111111";
  for (const [value, valid] of [
    [{ workspaceID: expected, label: "Personal · Example" }, true],
    [{ workspaceID: "other", label: "Wrong Workspace" }, false],
    [{ workspaceID: expected, label: "" }, false],
  ] as const) {
    const client = new FactorySourceClient(root, async (url, options) => {
      expect(String(url)).toBe(`${root}__factory/workspaces/${expected}/source/context`);
      expect(options?.credentials).toBe("same-origin");
      expect(options?.cache).toBe("no-store");
      expect(options?.body).toBeUndefined();
      return Response.json(value);
    });
    if (valid) expect(await client.presentation(expected)).toEqual(value);
    else await expect(client.presentation(expected)).rejects.toThrow("presentation is invalid");
  }
});
