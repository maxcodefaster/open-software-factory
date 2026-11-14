import { expect, test } from "bun:test";
import { requireOwnedProjectSourceRetention } from "../fixtures/editor-source-resources";

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
