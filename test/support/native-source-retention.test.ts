import { expect, test } from "bun:test";
import { requireOwnedProjectSourceRetention } from "../fixtures/editor-source-resources";
import { releaseSourceFile } from "../fixtures/release-cleanup";
import { createHash } from "node:crypto";

test("release Source proof decodes the native file bytes and rejects mismatched versions or text encoding", () => {
  const contract = {
    version: 1 as const,
    primaryApp: "web",
    apps: [
      { id: "web", label: "Owned App", command: ["node", "web.js"], port: 4321, healthPath: "/" },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(contract));
  const file = {
    content: bytes.toString("base64"),
    version: createHash("sha256").update(bytes).digest("hex"),
  };
  expect(releaseSourceFile(file)).toEqual({ version: file.version, contract });
  expect(() => releaseSourceFile({ ...file, version: "f".repeat(64) })).toThrow("reported version");
  expect(() => releaseSourceFile({ ...file, content: bytes.toString() })).toThrow();
});

test("native fixture teardown only observes Source retention and refuses unsettled recorded owners", async () => {
  let unsettled: { kind: string }[] = [];
  const queries: string[] = [];
  const projectID = crypto.randomUUID();
  const sql = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(parts.join("?"));
    expect(values).toEqual([projectID, projectID]);
    return unsettled;
  };
  const database = { client: sql } as unknown as Parameters<
    typeof requireOwnedProjectSourceRetention
  >[0];
  await requireOwnedProjectSourceRetention(database, projectID);
  expect(queries.every((query) => query.trimStart().startsWith("SELECT"))).toBe(true);
  expect(queries[0]).toContain("binding.deleted_at IS NULL");
  expect(queries[0]).toContain("source.owner<>'service'");
  for (const kind of ["runtime", "source"]) {
    unsettled = [{ kind }];
    await expect(requireOwnedProjectSourceRetention(database, projectID)).rejects.toThrow(
      "no data was released",
    );
  }
});
