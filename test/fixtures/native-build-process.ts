import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createSubstrateSources } from "../../apps/factory/src/workspace/substrate-source";
import type { createDatabase } from "../../packages/db/src/client";
import { fixture } from "./change-agent-turns";
import { eventually } from "./factory-process";
import type { nativeProcessProtocol } from "./native-process-protocol";
import { memoryPrivateObjects } from "./private-objects";

// Controlled prior work, not a live model/runtime proof. The actual admission,
// writer, native provisioning and OpenCode controller establish one completed
// no-change input and its confirmed Session before a process-recovery scenario.
export async function nativeBuildProcessFixture(
  database: ReturnType<typeof createDatabase>,
  native: Awaited<ReturnType<typeof nativeProcessProtocol>>,
) {
  const owned = await fixture(undefined, undefined, database, { runtime: "deferred-native" });
  const revision = "a".repeat(40);
  const originalParent = owned.hub.parentOperation.bind(owned.hub);
  owned.hub.parentOperation = async (...args) => {
    const result = await originalParent(...args);
    return args[1].action === "skills-install"
      ? result
      : { ...result, commitSHA: revision, remoteSHA: revision };
  };
  async function importSource() {
    const evidence = resolve(".factory/test-results/native-build-process");
    await mkdir(evidence, { recursive: true });
    const directory = await mkdtemp(join(evidence, "source-"));
    const binary = join(directory, "controlled-source");
    const content = Buffer.from("Owned prior Session source\n");
    const digest = createHash("sha256").update(content).digest("hex");
    let source: ReturnType<typeof createSubstrateSources> | undefined;
    try {
      // Controlled Source-service bytes, like the controlled RPC/OpenCode peer;
      // not native archive/materialization acceptance. Factory owns publication,
      // freeze, export checksums and the authenticated v2 import receipt.
      await writeFile(
        binary,
        `#!${process.execPath}
const input = await Bun.stdin.json();
const bytes = Buffer.from(${JSON.stringify(content.toString("base64"))}, "base64");
const bundle = {version:1,bytes:bytes.length,sha256:${JSON.stringify(digest)},chunks:[${JSON.stringify(digest)}]};
let checkpoint;
const server = Bun.serve({unix:input.socket,fetch:async request => {
  if(request.headers.get("authorization") !== "Bearer "+input.access.token ||
     request.headers.get("X-Factory-Source-Service") !== input.access.serviceId ||
     request.headers.get("X-Factory-Source-Epoch") !== String(input.access.epoch))
    return new Response(null,{status:403});
  const operation = new URL(request.url).pathname.split("/").at(-1);
  if(operation === "stat") return Response.json({kind:"directory"});
  const body = await request.json();
  if(operation === "checkpoint" && typeof body.checkpointId === "string" &&
     body.writerEpoch === input.access.ownerEpoch+1) {
    checkpoint ??= {checkpointId:body.checkpointId,writerEpoch:body.writerEpoch};
    if(JSON.stringify(checkpoint) === JSON.stringify(body)) return Response.json(bundle);
  }
  if(operation === "chunk" && checkpoint && body.checkpointId === checkpoint.checkpointId &&
     body.writerEpoch === checkpoint.writerEpoch && body.chunk === 0) return new Response(bytes);
  return new Response(null,{status:409});
}});
process.on("SIGTERM",async()=>{await server.stop(true);process.exit(0);});
`,
        { mode: 0o700 },
      );
      const previous = {
        FACTORY_STATE_DIRECTORY: process.env["FACTORY_STATE_DIRECTORY"],
        FACTORY_SOURCE_SERVICE_BINARY: process.env["FACTORY_SOURCE_SERVICE_BINARY"],
      };
      try {
        process.env["FACTORY_STATE_DIRECTORY"] = directory;
        process.env["FACTORY_SOURCE_SERVICE_BINARY"] = binary;
        source = createSubstrateSources(database, owned.hub, memoryPrivateObjects());
      } finally {
        for (const [key, value] of Object.entries(previous))
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
      }
      const initial = await source.lease(owned.workspaceID);
      if (!initial?.seed) throw Error("Controlled native prior Source seed is missing");
      expect(initial).toMatchObject({ owner: "service", actorUID: null, writable: true });
      const base = join(directory, "workspace-source", owned.workspaceID, initial.seed.id);
      await mkdir(join(base, "project"), { recursive: true });
      await writeFile(join(base, "project", "README.md"), content);
      await writeFile(join(base, "initial-source.json"), JSON.stringify(initial.seed));
      const headers = {
        ...(await native.connectorHeaders(owned.attemptID, "parent")),
        "X-Factory-Source-Protocol": "2",
      };
      const url = `https://owned-factory.test/internal/substrate-source/${owned.attemptID}`;
      const prepared = await source.restoreEndpoint(new Request(url, { headers }), owned.attemptID);
      expect(prepared.status).toBe(200);
      const reply = await prepared.json();
      const frozen = await source.lease(owned.workspaceID);
      if (!frozen?.checkpoint) throw Error("Controlled prior Source checkpoint is missing");
      expect(frozen).toMatchObject({ owner: "service", actorUID: null, writable: false });
      expect(reply).toMatchObject({
        version: 2,
        actorUID: headers["x-factory-runtime-actor-uid"],
        checkpointActorUID: null,
        checkpointSeedID: initial.seed.id,
        writerEpoch: frozen.checkpoint.writerEpoch + 1,
        checkpoint: frozen.checkpoint,
      });
      const chunks: Buffer[] = [];
      for (const [index, digest] of frozen.checkpoint.bundle.chunks.entries()) {
        const chunk = await source.restoreEndpoint(
          new Request(`${url}?checkpoint=${reply.checkpoint.id}&chunk=${index}`, {
            headers: { ...headers, "X-Factory-Source-Writer-Epoch": String(reply.writerEpoch) },
          }),
          owned.attemptID,
        );
        expect(chunk.status).toBe(200);
        const bytes = Buffer.from(await chunk.arrayBuffer());
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
        chunks.push(bytes);
      }
      const imported = Buffer.concat(chunks);
      expect(imported.length).toBe(frozen.checkpoint.bundle.bytes);
      expect(createHash("sha256").update(imported).digest("hex")).toBe(
        frozen.checkpoint.bundle.sha256,
      );
      expect(imported).toEqual(content);
      await writeFile(join(directory, "imported-source"), imported);
      const reread = await source.restoreEndpoint(new Request(url, { headers }), owned.attemptID);
      expect(reread.status).toBe(200);
      expect(await reread.json()).toEqual(reply);
      expect((await source.lease(owned.workspaceID))?.owner).toBe("service");
      const committed = await source.restoreEndpoint(
        new Request(url, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            checkpointID: reply.checkpoint.id,
            writerEpoch: reply.writerEpoch,
          }),
        }),
        owned.attemptID,
      );
      expect(committed.status).toBe(200);
      expect(await committed.json()).toEqual({
        version: 2,
        actorUID: headers["x-factory-runtime-actor-uid"],
        checkpointID: reply.checkpoint.id,
        writerEpoch: reply.writerEpoch,
        changeWriterEpoch: reply.changeWriterEpoch,
        readOnly: reply.readOnly,
      });
      expect(await source.lease(owned.workspaceID)).toMatchObject({
        owner: "actor",
        actorUID: headers["x-factory-runtime-actor-uid"],
        writerEpoch: reply.writerEpoch,
        writable: true,
        checkpoint: frozen.checkpoint,
      });
    } finally {
      await source?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  try {
    const controller = owned.controller(async () => {
      const id = await native.startWorkspace(
        owned.projectID,
        owned.userID,
        {
          version: 1,
          primaryApp: "web",
          apps: [
            {
              id: "web",
              label: "Owned Web",
              command: ["node", "web.js"],
              port: 4321,
              healthPath: "/",
            },
          ],
        },
        owned.changeID,
      );
      if (id !== owned.attemptID) throw Error("Controlled native Ticket identity changed");
      // Allocation is not an execution grant. Import/ACK the independent
      // Source before any controlled Child readiness or OpenCode input.
      expect(owned.requests()).toBe(0);
      await importSource();
      expect(owned.requests()).toBe(0);
      // This peer is in-process; the later real process must establish its own
      // transport readiness and cannot inherit these mocked connections.
      await database.client`UPDATE factory.runtime_attempt SET state='ready',ready_at=now() WHERE id=${id}`;
      await database.client`UPDATE factory.change SET state='active' WHERE id=${owned.changeID}`;
      return null;
    });
    const commandID = crypto.randomUUID();
    await controller.start(owned.changeID, owned.userID, commandID);
    await eventually(
      async () => {
        const turn = await owned.turn(commandID);
        if (turn && ["failed", "uncertain"].includes(turn.state))
          throw Error(`Controlled prior Session failed: ${turn.summary ?? turn.state}`);
        return owned.requests();
      },
      (count) => count === 1,
      "Controlled native prior Session did not submit its input",
    );
    await owned.requested;
    owned.finish();
    owned.release();
    await eventually(
      async () => {
        const [session] = await database.client<
          { state: string; turnState: string; error: string | null }[]
        >`
          SELECT session.state,turn.state AS "turnState",session.last_error AS error
          FROM factory.change_agent_session session JOIN factory.agent_turn turn
            ON turn.id=session.active_turn_id
          WHERE session.change_id=${owned.changeID}`;
        if (session?.error)
          throw Error(`Controlled prior Session did not settle: ${session.error}`);
        return session;
      },
      (session) => session?.state === "committed" && session.turnState === "completed",
      "Controlled native prior Session did not settle",
    );
    await controller.shutdown();
    const [bound] = await database.client<
      {
        uid: string;
        parentHash: string;
        childHash: string;
        sourceUID: string;
      }[]
    >`SELECT binding.actor_uid AS uid,attempt.parent_connector_token_hash AS "parentHash",
        attempt.child_connector_token_hash AS "childHash",source.actor_uid AS "sourceUID"
      FROM factory.runtime_attempt attempt JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
      JOIN factory.substrate_source source ON source.workspace_id=attempt.workspace_id
      WHERE attempt.id=${owned.attemptID}`;
    if (!bound || bound.uid !== bound.sourceUID || bound.parentHash === bound.childHash)
      throw Error("Controlled native prior Session has no original Source/role binding");
    for (const role of ["parent", "child"] as const) {
      const headers = await native.connectorHeaders(owned.attemptID, role);
      const hash = createHash("sha256").update(headers.authorization.slice(7)).digest("hex");
      if (hash !== (role === "parent" ? bound.parentHash : bound.childHash))
        throw Error("Controlled native role capability differs from its admission");
    }
    if (owned.requests() !== 1) throw Error("Controlled prior Session submitted another input");
    owned.hub.parentOperation = originalParent;
    await owned.nextInput();
    return owned;
  } catch (cause) {
    await owned.shutdown();
    owned.restoreEnvironment();
    throw cause;
  }
}
