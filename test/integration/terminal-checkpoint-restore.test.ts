import { expect, spyOn, test } from "bun:test";
import { createDatabase } from "#db/client";
import { runtimeModelToken } from "#runtime-domain/identity";
import { runCommand } from "#runtime-kubernetes/command";
import { createAgentController } from "../../apps/factory/src/agent/controller";
import { terminalOutcomeInput } from "../../apps/factory/src/agent/terminal-outcome";
import { createModelRelay } from "../../apps/factory/src/models/relay";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";
import {
  ownedPostgresServer,
  ownedTestDatabase,
  type PostgresIdentity,
} from "../fixtures/postgres-server";
import { cleanupPeer } from "../fixtures/terminal-cleanup-peer";

type Database = ReturnType<typeof createDatabase>;
type Owned = Awaited<ReturnType<typeof fixture>>;

function connect(url: string) {
  const previous = process.env["DATABASE_URL"];
  try {
    process.env["DATABASE_URL"] = url;
    return createDatabase(3);
  } finally {
    if (previous === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previous;
  }
}

async function until(read: () => Promise<boolean>, wake: () => void, label: string) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    wake();
    if (await read()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Owned terminal restore did not reach ${label}`);
}

async function snapshot(database: Database, changeID: string, commandID: string) {
  const [row] = await database.client<
    {
      state: string;
      input: unknown;
      authority: unknown;
      intent: { terminal_outcome: unknown; prompt_id: string; prompt_text: string };
      epoch: string;
      session: unknown;
      runtime: unknown;
      workspace: unknown;
    }[]
  >`
    SELECT turn.state,turn.input,turn.authority,to_jsonb(intent) AS intent,
      intent.model_request_epoch::text AS epoch,to_jsonb(session) AS session,
      to_jsonb(attempt) AS runtime,to_jsonb(workspace) AS workspace
    FROM factory.agent_turn turn
    JOIN factory.change_agent_turn_intent intent ON intent.turn_id=turn.id
    JOIN factory.change_agent_session session ON session.active_turn_id=turn.id
      AND session.change_id=turn.change_id
    JOIN factory.runtime_attempt attempt ON attempt.id=intent.runtime_attempt_id
    JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
    WHERE turn.change_id=${changeID} AND turn.command_id=${commandID}`;
  if (!row) throw new Error("Exact owned controller input and terminal checkpoint are missing");
  return row;
}

function relay(database: Database, attemptID: string) {
  const secret = "owned-terminal-restore-not-an-installation-credential";
  const send = createModelRelay(database, secret, {
    baseURL: "https://owned-terminal-restore.invalid/v1",
    apiKey: "owned-controlled-provider-key",
  });
  return () =>
    send(
      new Request("http://factory.invalid/internal/model", {
        method: "POST",
        headers: { authorization: `Bearer ${runtimeModelToken(secret, attemptID, 1)}` },
        body: JSON.stringify({ model: buildModelID, reasoning: { effort: "medium" }, input: [] }),
      }),
      attemptID,
      "responses",
    );
}

function databaseName(url: string) {
  const name = new URL(url).pathname.slice(1);
  if (!/^owned_[a-f0-9]{32}$/.test(name)) throw new Error("Disposable owned database required");
  return name;
}

test("pg_dump restore preserves a running terminal checkpoint, immutable input and closed relay", async () => {
  let server: Awaited<ReturnType<typeof ownedPostgresServer>> | undefined;
  let source: Awaited<ReturnType<typeof ownedTestDatabase>> | undefined;
  let target: Awaited<ReturnType<typeof ownedTestDatabase>> | undefined;
  let sourceDatabase: Database | undefined;
  let restored: Database | undefined;
  let owned: Owned | undefined;
  let controller: ReturnType<typeof createAgentController> | undefined;
  let peer: ReturnType<typeof cleanupPeer> | undefined;
  // Only the provider boundary is controlled. Admission, monitor, checkpoint,
  // relay epoch, PostgreSQL dump/restore and immutable triggers are real.
  const provider = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ ownedTerminalRestoreProvider: true }),
  );
  try {
    const supplied = process.env["FACTORY_TEST_POSTGRES"];
    let identity: PostgresIdentity;
    if (supplied) identity = JSON.parse(supplied) as PostgresIdentity;
    else {
      server = await ownedPostgresServer();
      identity = server.identity;
    }
    source = await ownedTestDatabase(identity, crypto.randomUUID());
    sourceDatabase = connect(source.url);
    owned = await fixture(undefined, undefined, sourceDatabase);
    const retained = owned;
    controller = createAgentController(
      owned.database,
      owned.hub,
      { startPersisted: async () => null },
      undefined,
      owned.writers,
    );
    const originalRequest = owned.hub.request.bind(owned.hub);
    peer = cleanupPeer(
      owned.sessionID,
      "cleanup-abort",
      (request, path) => originalRequest(retained.attemptID, "agent", request, path),
      owned.publishActivity,
    );
    const native = peer;
    owned.hub.request = async (attempt, channel, request, path) => {
      if (attempt !== retained.attemptID || channel !== "agent")
        throw new Error("Terminal restore transport escaped its owned attempt");
      return native.transport(request, path);
    };
    const commandID = crypto.randomUUID();
    owned.acceptResponse();
    await controller.prompt(
      owned.changeID,
      "Preserve this exact terminal checkpoint through the owned database restore",
      owned.userID,
      commandID,
    );
    await until(async () => retained.requests() === 1, owned.publishActivity, "one native prompt");
    peer.begin();
    owned.release();
    await until(
      async () => (await retained.turn(commandID))?.state === "running",
      owned.publishActivity,
      "the real running turn",
    );
    // A nonzero epoch catches a restore that silently replaces the new field
    // with its default. This is one controlled reply, never a paid model call.
    const admitted = await relay(owned.database, owned.attemptID)();
    expect(admitted.status).toBe(200);
    await admitted.body?.cancel();
    expect(provider.mock.calls).toHaveLength(1);
    peer.finish();
    owned.finish();
    await until(
      async () => native.snapshot().removals === 1,
      owned.publishActivity,
      "checkpointed cleanup with its acknowledgement held",
    );
    const held = await snapshot(owned.database, owned.changeID, commandID);
    const checkpoint = terminalOutcomeInput.parse(held.intent.terminal_outcome);
    expect(held.state).toBe("running");
    expect(held.epoch).toBe("1");
    expect(checkpoint).toMatchObject({
      attemptID: owned.attemptID,
      sessionID: owned.sessionID,
      promptID: (owned.payloads[0] as { id: string }).id,
      modelRequestEpoch: "1",
      outcome: { state: "succeeded" },
    });
    expect(owned.commitCalls).toEqual([]);
    expect((await relay(owned.database, owned.attemptID)()).status).toBe(403);
    expect(provider.mock.calls).toHaveLength(1);

    // No original controller may observe or settle work while the target exists.
    const stopping = controller.shutdown();
    peer.releaseRemoval();
    await stopping;
    await owned.shutdown();
    const before = await snapshot(owned.database, owned.changeID, commandID);
    expect(before.state).toBe("running");
    expect(before.intent).toEqual(held.intent);
    expect(before.input).toEqual(held.input);
    expect(before.epoch).toBe("1");
    const container = `factory-test-postgres-${identity.owner}`;
    const dump = await runCommand(
      [
        "docker",
        "exec",
        container,
        "pg_dump",
        "-U",
        "factory",
        "-d",
        databaseName(source.url),
        "--no-owner",
        "--no-acl",
      ],
      undefined,
      { timeoutMS: 30_000, outputBytes: 8 * 1024 ** 2 },
    );
    expect(dump.exitCode).toBe(0);
    expect(dump.stdout.length).toBeGreaterThan(0);
    target = await ownedTestDatabase(identity, crypto.randomUUID(), false, "template0");
    expect(target.url).not.toBe(source.url);
    restored = connect(target.url);
    expect(
      await restored.client`SELECT nspname FROM pg_namespace
      WHERE nspname IN ('factory','auth')`,
    ).toHaveLength(0);
    // Same pinned server supplies pg_dump and psql. Restore the dump's schema,
    // rows and post-data triggers; do not migrate/reinitialize over its data.
    const restore = await runCommand(
      [
        "docker",
        "exec",
        "-i",
        container,
        "psql",
        "-X",
        "-U",
        "factory",
        "-d",
        databaseName(target.url),
        "--single-transaction",
        "--set",
        "ON_ERROR_STOP=1",
      ],
      dump.stdout,
      { timeoutMS: 30_000, outputBytes: 1024 * 1024 },
    );
    if (restore.exitCode !== 0) throw new Error(`Owned terminal restore failed: ${restore.stderr}`);
    expect(await snapshot(restored, owned.changeID, commandID)).toEqual(before);
    for (const column of [
      "terminal_outcome=NULL",
      "model_request_epoch=model_request_epoch+1",
      "prompt_text=prompt_text||' changed'",
    ]) {
      await expect(
        Promise.resolve(
          restored.client.unsafe(
            `UPDATE factory.change_agent_turn_intent SET ${column} WHERE turn_id=$1`,
            [checkpoint.turnID],
          ),
        ),
      ).rejects.toThrow("immutable");
    }
    // An expired lease would make 403 vacuous. Never extend or rewrite the
    // restored owner; require this bounded round-trip to preserve live authority.
    const [authority] = await restored.client<{ otherwiseActive: boolean }[]>`
      SELECT turn.state='running' AND turn.owner_token IS NOT NULL
        AND turn.owner_expires_at>clock_timestamp() AND session.state='working'
        AND NOT session.stop_pending AND attempt.state='ready' AS "otherwiseActive"
      FROM factory.agent_turn turn
      JOIN factory.change_agent_session session ON session.active_turn_id=turn.id
      JOIN factory.runtime_attempt attempt ON attempt.id=session.runtime_attempt_id
      WHERE turn.id=${checkpoint.turnID}`;
    expect(authority?.otherwiseActive).toBe(true);
    expect((await relay(restored, owned.attemptID)()).status).toBe(403);
    expect(provider.mock.calls).toHaveLength(1);
    expect(await snapshot(restored, owned.changeID, commandID)).toEqual(before);
    expect(await snapshot(owned.database, owned.changeID, commandID)).toEqual(before);
    expect(owned.requests()).toBe(1);
    expect(owned.commitCalls).toEqual([]);
  } finally {
    peer?.disable();
    try {
      await controller?.shutdown();
    } finally {
      try {
        await restored?.client.end({ timeout: 2 });
      } finally {
        try {
          await target?.dispose();
        } finally {
          try {
            if (owned) await owned.dispose();
            else await sourceDatabase?.client.end({ timeout: 2 });
          } finally {
            try {
              await source?.dispose();
            } finally {
              try {
                await server?.dispose();
              } finally {
                provider.mockRestore();
              }
            }
          }
        }
      }
    }
  }
}, 180_000);
