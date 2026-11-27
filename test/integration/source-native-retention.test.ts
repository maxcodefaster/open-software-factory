import { expect, test } from "bun:test";
import { hashConnectorToken, runtimeConnectorTokens } from "#runtime-domain/identity";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import { memoryPrivateObjects } from "../fixtures/private-objects";
import { substrateFixture } from "../fixtures/substrate";

async function fixture() {
  const f = await substrateFixture();
  try {
    const actorUID = crypto.randomUUID();
    const tokens = runtimeConnectorTokens("owned-native-secret", f.attemptID, 1);
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.substrate_provision(owner_id,kind,generation,intent,resources)
        VALUES(${f.workspaceID},'workspace',1,${JSON.stringify({ templateSHA256: f.config.templateSHA256 })}::text::jsonb,
          ${JSON.stringify({
            atespace: { attemptedAt: f.space.metadata.createTime, value: f.space },
            template: { attemptedAt: f.template.metadata.createTime, value: f.template },
          })}::text::jsonb)`;
      await sql`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,
          parent_connector_token_hash,create_intended_at,created_by,
          atespace,actor_name,binding_intent,actor_uid,create_attempted_at)
        VALUES(${f.attemptID},${f.projectID},${f.workspaceID},1,${"a".repeat(40)},'create-intended',
          ${hashConnectorToken(tokens.parent)},now(),${f.userID},
          ${f.atespace},${`runtime-${f.attemptID.replaceAll("-", "")}`},
          ${JSON.stringify({
            sourceRestoreProtocol: 2,
            workspaceID: f.workspaceID,
            generation: 1,
            templateUID: f.template.metadata.uid,
            atespaceUID: f.space.metadata.uid,
            templateVersion: f.template.metadata.version,
            templateSHA256: f.config.templateSHA256,
          })}::jsonb,
          ${actorUID},now())`;
      // Controlled already-admitted Actor Source, not an initial-import proof.
      await f.admitActorSource(actorUID, sql);
      await sql`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${f.attemptID}`;
    });
    const sources = createSubstrateSources(f.database, f.hub, memoryPrivateObjects());
    const request = () =>
      new Request(`https://factory.test/internal/substrate-source/${f.attemptID}`, {
        headers: {
          authorization: `Bearer ${tokens.parent}`,
          "X-Factory-Runtime-Actor-UID": actorUID,
          "X-Factory-Runtime-Generation": "1",
          "X-Factory-Source-Protocol": "2",
        },
      });
    return {
      ...f,
      actorUID,
      sources,
      request,
      async dispose() {
        await sources.close();
        await f.dispose();
      },
    };
  } catch (cause) {
    await f.dispose();
    throw cause;
  }
}

test("native cold wake grants the retained Actor without offering an old Source bundle or changing its owner", async () => {
  const f = await fixture();
  try {
    const before = await f.sources.lease(f.workspaceID);
    for (let observation = 0; observation < 2; observation++) {
      const response = await f.sources.restoreEndpoint(f.request(), f.attemptID);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        version: 2,
        retained: true,
        actorUID: f.actorUID,
        writerEpoch: 1,
        changeWriterEpoch: 1,
        readOnly: false,
        checkpoint: null,
      });
      expect(await f.sources.lease(f.workspaceID)).toEqual(before);
    }
    const download = new URL(f.request().url);
    download.searchParams.set("chunk", "0");
    expect(
      (
        await f.sources.restoreEndpoint(
          new Request(download, {
            headers: f.request().headers,
          }),
          f.attemptID,
        )
      ).status,
    ).toBe(409);
  } finally {
    await f.dispose();
  }
});

test.each(["actor", "generation", "token", "paused"] as const)(
  "retained Source rejects a foreign or unadmitted %s without changing files or ownership",
  async (scenario) => {
    const f = await fixture();
    try {
      const before = await f.sources.lease(f.workspaceID);
      const request = f.request();
      if (scenario === "actor")
        request.headers.set("X-Factory-Runtime-Actor-UID", crypto.randomUUID());
      if (scenario === "generation") request.headers.set("X-Factory-Runtime-Generation", "2");
      if (scenario === "token") request.headers.set("Authorization", "Bearer not-this-actor");
      if (scenario === "paused")
        await f.database
          .client`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${f.attemptID}`;
      expect((await f.sources.restoreEndpoint(request, f.attemptID)).status).toBe(403);
      expect(await f.sources.lease(f.workspaceID)).toEqual(before);
    } finally {
      await f.dispose();
    }
  },
);

test("obsolete MEMORY Source-renewal headers cannot reactivate the removed handoff protocol", async () => {
  const f = await fixture();
  try {
    const request = f.request();
    request.headers.set("X-Factory-Source-Continuation", "memory");
    request.headers.set("X-Factory-Source-Previous-Checkpoint", crypto.randomUUID());
    expect((await f.sources.restoreEndpoint(request, f.attemptID)).status).toBe(400);
  } finally {
    await f.dispose();
  }
});
