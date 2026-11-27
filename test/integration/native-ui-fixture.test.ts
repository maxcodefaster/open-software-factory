import { expect, test } from "bun:test";
import { createDatabase } from "#db/client";
import { ownedPostgresServer } from "../fixtures/postgres-server";
import { startSubstrateFixtureWorkspace, substrateFixture } from "../fixtures/substrate";
import { deleteFactoryProject } from "../support/factory-fixture";

test("UI cleanup refuses retained database names and native dispatch, and only releases uncreated owned planning fixtures", async () => {
  const server = await ownedPostgresServer();
  const previous = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = server.identity.url;
  const retainedName = createDatabase();
  if (previous === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = previous;
  try {
    await expect(deleteFactoryProject(crypto.randomUUID(), retainedName)).rejects.toThrow(
      "retained data was not changed",
    );
  } finally {
    await retainedName.client.end({ timeout: 1 });
    await server.dispose();
  }
  const native = await substrateFixture();
  try {
    await startSubstrateFixtureWorkspace(native);
    const before = await native.database.client`SELECT * FROM factory.runtime_attempt
      WHERE id=${native.attemptID}`;
    await expect(deleteFactoryProject(native.projectID, native.database)).rejects.toThrow(
      "no product history or Source was deleted",
    );
    expect(
      await native.database.client`SELECT * FROM factory.runtime_attempt
      WHERE id=${native.attemptID}`,
    ).toEqual(before);
    expect(
      await native.database.client`SELECT id FROM factory.project WHERE id=${native.projectID}`,
    ).toHaveLength(1);
  } finally {
    await native.dispose();
  }
  const intended = await substrateFixture();
  try {
    await intended.database.client`INSERT INTO factory.substrate_provision(owner_id,kind,intent)
      VALUES(${intended.workspaceID},'workspace','{}')`;
    await expect(deleteFactoryProject(intended.projectID, intended.database)).rejects.toThrow(
      "no product history or Source was deleted",
    );
    expect(
      await intended.database.client`SELECT owner_id FROM factory.substrate_provision
      WHERE owner_id=${intended.workspaceID} AND kind='workspace'`,
    ).toHaveLength(1);
  } finally {
    await intended.dispose();
  }
  const planning = await substrateFixture();
  try {
    await deleteFactoryProject(planning.projectID, planning.database);
    expect(
      await planning.database.client`SELECT id FROM factory.project WHERE id=${planning.projectID}`,
    ).toHaveLength(0);
  } finally {
    await planning.dispose();
  }
}, 60_000);
