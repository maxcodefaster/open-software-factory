import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import {
  type AgentTurnTransaction,
  createAgentTurnStore,
} from "../../apps/factory/src/agent/turn-store";
import { createDatabase } from "../../packages/db/src/client";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";

import { buildModelID, fixture } from "../fixtures/change-agent-turns";

test("Build waits for OpenCode after IDE readiness without repeating a prompt", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  const request = owned.hub.request.bind(owned.hub);
  let healthReads = 0;
  owned.hub.request = async (attempt, channel, input, path) => {
    if (new URL(input.url).pathname === "/api/info") {
      healthReads += 1;
      if (healthReads <= 2) return Response.json({ error: "Starting" }, { status: 503 });
    }
    return request(attempt, channel, input, path);
  };
  try {
    await owned
      .controller()
      .prompt(owned.changeID, "Wait for Agent startup", owned.userID, commandID);
    await owned.requested;
    expect(healthReads).toBe(3);
    expect(owned.requests()).toBe(1);
    expect(
      (
        await owned.database
          .client`SELECT state FROM factory.runtime_attempt WHERE id = ${owned.attemptID}`
      )[0]?.["state"],
    ).toBe("ready");
  } finally {
    await owned.dispose();
  }
}, 10_000);

test("Stop during OpenCode readiness admits no Session or prompt", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  const request = owned.hub.request.bind(owned.hub);
  const reached = Promise.withResolvers<void>();
  owned.hub.request = async (attempt, channel, input, path) => {
    if (new URL(input.url).pathname === "/api/info") {
      reached.resolve();
      return Response.json({ error: "Starting" }, { status: 503 });
    }
    return request(attempt, channel, input, path);
  };
  try {
    const controller = owned.controller();
    await controller.prompt(owned.changeID, "Stop before Agent startup", owned.userID, commandID);
    await reached.promise;
    await controller.stop(owned.changeID);
    await Bun.sleep(600);
    expect(owned.requests()).toBe(0);
    expect((await owned.turn(commandID))?.state).toBe("stopped");
    expect(owned.commitCalls).toHaveLength(0);
  } finally {
    await owned.dispose();
  }
}, 10_000);

async function until(check: () => Promise<boolean>, observations = 100) {
  for (let i = 0; i < observations; i += 1) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Owned Build assertion did not become true");
}

async function buildConversation(owned: Awaited<ReturnType<typeof fixture>>) {
  const id = crypto.randomUUID();
  await owned.database
    .client`INSERT INTO factory.ticket_conversation(id, project_id, ticket_id, mode, created_by)
    VALUES (${id}, ${owned.projectID}, ${owned.ticketID}, 'build', ${owned.userID})`;
  return id;
}

async function modeRoundTrip(owned: Awaited<ReturnType<typeof fixture>>, conversationID: string) {
  await owned.database
    .client`UPDATE factory.ticket_conversation SET mode = 'plan', version = version + 1
    WHERE id = ${conversationID}`;
  await owned.database
    .client`UPDATE factory.ticket_conversation SET mode = 'build', version = version + 1
    WHERE id = ${conversationID}`;
}

test("explicit Build retry recovers a failed pre-Session runtime without rewriting its old turn", async () => {
  const owned = await fixture();
  const admission = createChangeAdmission(owned.database, buildModelID);
  const turns = createAgentTurnStore(owned.database);
  try {
    await owned.database
      .client`DELETE FROM factory.change_agent_session WHERE change_id=${owned.changeID}`;
    await owned.database
      .client`INSERT INTO factory.branch_create_operation(id,change_id,repository_owner,repository_name,branch_name,start_sha,idempotency_key,state,observed_head_sha,completed_at)
      SELECT ${crypto.randomUUID()},id,'owned','fixture',branch_name,base_sha,${crypto.randomUUID()},'succeeded',base_sha,now() FROM factory.change WHERE id=${owned.changeID}`;
    const first = await admission.admit(owned.changeID, owned.userID, {
      kind: "change-start",
      commandId: crypto.randomUUID(),
    });
    const claimed = await turns.claimPending(first.turn.id);
    if (!claimed?.ownerToken) throw new Error("Missing owned runtime preparation lease");
    expect(
      await turns.failPending(first.turn.id, claimed.ownerToken, "Canonical source deadline"),
    ).toBe(true);
    await owned.database
      .client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${owned.attemptID}`;
    await owned.database
      .client`UPDATE factory.change SET state='failed',failure='Runtime preparation failed' WHERE id=${owned.changeID}`;
    const old = await turns.get(first.turn.id);
    const retryCommand = { kind: "change-start" as const, commandId: crypto.randomUUID() };
    const retry = await admission.admit(owned.changeID, owned.userID, retryCommand);
    expect(retry.turn.id).not.toBe(first.turn.id);
    expect(retry.turn.state).toBe("pending");
    expect((await admission.admit(owned.changeID, owned.userID, retryCommand)).turn.id).toBe(
      retry.turn.id,
    );
    expect(await turns.get(first.turn.id)).toEqual(old);
    const retryOwner = await turns.claimPending(retry.turn.id);
    if (!retryOwner?.ownerToken) throw new Error("Missing owned retry lease");
    expect(await turns.validateExecution(retry.turn.id, retryOwner.ownerToken)).toBe(true);
    expect(owned.requests()).toBe(0);
  } finally {
    await owned.dispose();
  }
});

test("a reserved native Session is not presented as resumable before acknowledged creation", async () => {
  const owned = await fixture();
  const firstCommand = crypto.randomUUID();
  let recovering = false;
  let nativeCreates = 0;
  let nativeSession: { id: string; location: { directory: string }; model: unknown } | undefined;
  const request = owned.hub.request.bind(owned.hub);
  owned.hub.request = async (attempt, channel, input, path) => {
    const pathname = new URL(input.url).pathname;
    if (pathname === "/api/session" && input.method === "POST") {
      nativeCreates++;
      nativeSession = await input.json();
      return Response.json({ data: nativeSession });
    }
    if (nativeSession && pathname === `/api/session/${nativeSession.id}`)
      return Response.json({ data: nativeSession });
    if (nativeSession && pathname.endsWith("/log"))
      return new Response(
        `data: ${JSON.stringify({ type: "log.synced", aggregateID: nativeSession.id, seq: 1 })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    return request(attempt, channel, input, path);
  };
  const controller = owned.controller(async () => {
    if (recovering) {
      await owned.database
        .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${owned.attemptID}`;
      await owned.database
        .client`UPDATE factory.change SET state='active' WHERE id=${owned.changeID}`;
    }
    return null;
  });
  try {
    await owned.database
      .client`DELETE FROM factory.change_agent_session WHERE change_id=${owned.changeID}`;
    await owned.database
      .client`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${owned.attemptID}`;
    await owned.database
      .client`INSERT INTO factory.branch_create_operation(id,change_id,repository_owner,repository_name,branch_name,start_sha,idempotency_key,state,observed_head_sha,completed_at)
      SELECT ${crypto.randomUUID()},id,'owned','fixture',branch_name,base_sha,${crypto.randomUUID()},'succeeded',base_sha,now()
      FROM factory.change WHERE id=${owned.changeID}`;
    await controller.start(owned.changeID, owned.userID, firstCommand);
    await until(async () =>
      Boolean(
        (
          await owned.database
            .client`SELECT change_id FROM factory.change_agent_session WHERE change_id=${owned.changeID}`
        )[0],
      ),
    );
    expect((await controller.get(owned.changeID, undefined, false)).sessionAvailable).toBe(false);
    expect(nativeCreates).toBe(0);
    await owned.database
      .client`UPDATE factory.runtime_attempt SET state='failed' WHERE id=${owned.attemptID}`;
    await owned.database
      .client`UPDATE factory.change SET state='failed' WHERE id=${owned.changeID}`;
    await until(async () => (await owned.turn(firstCommand))?.state === "failed", 2000);
    const failed = await controller.get(owned.changeID, undefined, false);
    expect(failed.sessionAvailable).toBe(false);
    expect(failed.lastError).toContain("Workspace failed to start");
    expect(owned.requests()).toBe(0);
    const previous = await owned.turn(firstCommand);
    // The fixture writer's Stop transport is inert. Observe its owned fence
    // as stopped before testing the next native bootstrap.
    await owned.database
      .client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${owned.attemptID}`;
    recovering = true;
    const retryCommand = crypto.randomUUID();
    const retry = await controller.start(owned.changeID, owned.userID, retryCommand);
    await until(
      async () =>
        owned.requests() > 0 ||
        ["failed", "stopped", "uncertain"].includes((await owned.turn(retryCommand))?.state ?? ""),
      2000,
    );
    expect(owned.requests(), JSON.stringify(await owned.turn(retryCommand))).toBe(1);
    expect(nativeCreates).toBe(1);
    expect((await controller.get(owned.changeID, undefined, false)).sessionAvailable).toBe(true);
    expect(await owned.turn(firstCommand)).toEqual(previous);
    expect(retry.turn?.id).not.toBe(previous?.id);
  } finally {
    await owned.dispose();
  }
}, 30_000);

async function newerRequirements(
  sql: AgentTurnTransaction,
  owned: Awaited<ReturnType<typeof fixture>>,
) {
  const canonical = canonicalRequirementContent({
    summary: "New unapproved Requirements",
    acceptanceCriteria: ["New behavior requires its own approval"],
    nonGoals: [],
  });
  await sql`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
    SELECT ${crypto.randomUUID()}, ticket_id, ordinal + 1, ${canonical},
      ${createHash("sha256").update(canonical).digest("hex")}, created_by
      FROM factory.requirement_revision WHERE id = ${owned.revisionID}`;
}

test("Build admission rejects Requirements committed while waiting for the Ticket lock", async () => {
  const owned = await fixture();
  const locked = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const writer = owned.database.client
    .begin(async (sql) => {
      const rows = await sql<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid
      FROM factory.ticket WHERE id = ${owned.ticketID} FOR UPDATE`;
      if (!rows[0]) throw new Error("Owned Ticket lock required");
      await newerRequirements(sql, owned);
      locked.resolve(rows[0].pid);
      await release.promise;
    })
    .catch((cause: unknown) => {
      locked.reject(cause);
      throw cause;
    });
  let admission: Promise<unknown> | undefined;
  try {
    const blockerPID = await locked.promise;
    admission = createChangeAdmission(owned.database, buildModelID).admit(
      owned.changeID,
      owned.userID,
      {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "Require the latest approval after waiting",
      },
    );
    await until(async () => {
      const blocked = await owned.database.client`SELECT pid FROM pg_stat_activity
        WHERE ${blockerPID} = ANY(pg_blocking_pids(pid))`;
      return blocked.length > 0;
    });
    release.resolve();
    await writer;
    await expect(admission).rejects.toMatchObject({ code: "conflict" });
    expect(
      await owned.database
        .client`SELECT id FROM factory.agent_turn WHERE project_id = ${owned.projectID}`,
    ).toHaveLength(0);
  } finally {
    release.resolve();
    await writer.catch(() => {});
    await admission?.catch(() => {});
    await owned.dispose();
  }
});

test("running Build observation waits for native activity rather than polling history every second", async () => {
  const owned = await fixture();
  const controller = owned.controller();
  const commandID = crypto.randomUUID();
  const request = owned.hub.request.bind(owned.hub);
  let reads = 0;
  let running = true;
  owned.hub.request = async (attempt, channel, input, path) => {
    if (new URL(input.url).pathname.endsWith("/active")) {
      reads++;
      return Response.json({ data: running ? { [owned.sessionID]: { type: "running" } } : {} });
    }
    return request(attempt, channel, input, path);
  };
  try {
    owned.acceptResponse();
    await controller.prompt(owned.changeID, "Observe native activity", owned.userID, commandID);
    await owned.requested;
    owned.release();
    await until(async () => reads > 0, 300);
    await Bun.sleep(200);
    const initial = reads;
    await Bun.sleep(1_200);
    expect(reads).toBe(initial);
    expect((await owned.turn(commandID))?.state).toBe("running");
    running = false;
    owned.finish();
    await until(async () => (await controller.get(owned.changeID)).state === "committed", 300);
    expect(owned.requests()).toBe(1);
    expect(owned.commitCalls).toEqual(["git-prepare-commit", "git-push"]);
  } finally {
    await owned.dispose();
  }
}, 20_000);

test("ordinary monitoring settles an inactive promoted input without a terminal outcome as uncertain", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  const request = owned.hub.request.bind(owned.hub);
  owned.hub.request = async (attempt, channel, input, path) => {
    if (new URL(input.url).pathname.endsWith("/message")) {
      const prompt = owned.payloads[0] as { id: string; text: string } | undefined;
      return Response.json({
        data: prompt
          ? [{ id: prompt.id, type: "user", text: prompt.text, time: { created: 1 } }]
          : [],
      });
    }
    return request(attempt, channel, input, path);
  };
  try {
    owned.acceptResponse();
    await owned
      .controller()
      .prompt(owned.changeID, "Observe lost execution", owned.userID, commandID);
    await owned.requested;
    owned.release();
    await until(async () => (await owned.turn(commandID))?.state === "uncertain", 300);
    expect(await owned.controller().get(owned.changeID)).toMatchObject({
      state: "failed",
      turn: { state: "uncertain" },
    });
    expect(owned.requests()).toBe(1);
    expect(owned.commitCalls).toHaveLength(0);
  } finally {
    await owned.controller().stop(owned.changeID);
    await owned.dispose();
  }
});

test("a cancelled read-only observation keeps monitoring the same Build without another prompt", async () => {
  const owned = await fixture();
  const controller = owned.controller();
  const commandID = crypto.randomUUID();
  const request = owned.hub.request.bind(owned.hub);
  let reads = 0;
  let finished = false;
  owned.hub.request = async (attempt, channel, input, path) => {
    if (new URL(input.url).pathname.endsWith("/active")) {
      reads++;
      if (reads === 1) throw new Error("Runtime request was cancelled");
      if (!finished) return Response.json({ data: { [owned.sessionID]: { type: "running" } } });
    }
    return request(attempt, channel, input, path);
  };
  try {
    owned.acceptResponse();
    await controller.prompt(
      owned.changeID,
      "Keep observing this implementation",
      owned.userID,
      commandID,
    );
    await owned.requested;
    owned.release();
    await until(async () => reads >= 1, 300);
    owned.publishActivity();
    await until(async () => reads >= 2, 300);
    expect((await owned.turn(commandID))?.state).toBe("running");
    expect(owned.requests()).toBe(1);
    finished = true;
    owned.finish();
    await until(async () => (await controller.get(owned.changeID)).state === "committed", 500);
    expect(owned.requests()).toBe(1);
    expect(owned.commitCalls).toEqual(["git-prepare-commit", "git-push"]);
  } finally {
    await owned.dispose();
  }
}, 20_000);

// Activity changes invalidate native observations. Only a second consecutive
// inactive observation uses the one-second ambiguity check.
test("nonconsecutive inactive snapshots do not strand or prematurely settle running work", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  const request = owned.hub.request.bind(owned.hub);
  let activeReads = 0;
  let completed = false;
  owned.hub.request = async (attempt, channel, input, path) => {
    if (new URL(input.url).pathname.endsWith("/active")) {
      activeReads += 1;
      return Response.json({
        data:
          completed || activeReads === 1 || activeReads === 3
            ? {}
            : { [owned.sessionID]: { type: "running" } },
      });
    }
    return request(attempt, channel, input, path);
  };
  try {
    owned.acceptResponse();
    await owned
      .controller()
      .prompt(owned.changeID, "Observe transient activity", owned.userID, commandID);
    await owned.requested;
    owned.release();
    for (let expected = 1; expected < 4; expected++) {
      await until(async () => activeReads >= expected, 300);
      owned.publishActivity();
    }
    await until(async () => activeReads >= 4, 500);
    expect((await owned.turn(commandID))?.state).toBe("running");
    completed = true;
    owned.finish();
    await until(
      async () => (await owned.controller().get(owned.changeID)).state === "committed",
      300,
    );
    expect((await owned.turn(commandID))?.state).toBe("completed");
    expect(owned.requests()).toBe(1);
    expect(owned.commitCalls).toEqual(["git-prepare-commit", "git-push"]);
  } finally {
    await owned.controller().stop(owned.changeID);
    await owned.dispose();
  }
}, 20_000);

test("a Build mode round trip cannot restore pending dispatch authority", async () => {
  const owned = await fixture();
  try {
    const conversationID = await buildConversation(owned);
    const admitted = await createChangeAdmission(owned.database, buildModelID).admit(
      owned.changeID,
      owned.userID,
      { kind: "change-prompt", commandId: crypto.randomUUID(), text: "Fence this exact version" },
    );
    const store = createAgentTurnStore(owned.database);
    const claimed = await store.claimPending(admitted.turn.id);
    if (!claimed?.ownerToken) throw new Error("Owned claim required");
    await modeRoundTrip(owned, conversationID);
    expect(await store.beginDispatch(claimed.id, claimed.ownerToken)).toBeNull();
    expect(owned.requests()).toBe(0);
  } finally {
    await owned.dispose();
  }
});

test("a Build mode round trip cannot publish a late outcome or commit", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  try {
    const conversationID = await buildConversation(owned);
    owned.finish();
    await owned
      .controller()
      .prompt(owned.changeID, "Fence the late result", owned.userID, commandID);
    await owned.requested;
    await modeRoundTrip(owned, conversationID);
    owned.release();
    await until(async () =>
      ["completed", "failed", "uncertain"].includes((await owned.turn(commandID))?.state ?? ""),
    );
    expect((await owned.turn(commandID))?.state).toBe("uncertain");
    expect(owned.commitCalls).toHaveLength(0);
    expect(owned.interrupts()).toBe(0);
    await expect(
      owned
        .controller()
        .prompt(owned.changeID, "Do not overlap uncertain work", owned.userID, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "conflict" });
  } finally {
    await owned.dispose();
  }
});

test("a Build mode round trip cannot restore uncertain external authority", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  try {
    const conversationID = await buildConversation(owned);
    await owned
      .controller()
      .prompt(owned.changeID, "Fence the recovered result", owned.userID, commandID);
    await owned.requested;
    owned.release();
    await until(async () => (await owned.turn(commandID))?.state === "uncertain");
    await modeRoundTrip(owned, conversationID);
    owned.finish();
    await owned.controller().recover();
    await until(async () => {
      const view = await owned.controller().get(owned.changeID);
      return view.turn?.state === "completed" || !!view.turn?.summary?.includes("authority");
    });
    expect((await owned.turn(commandID))?.state).toBe("uncertain");
    expect(owned.commitCalls).toHaveLength(0);
  } finally {
    await owned.dispose();
  }
});

test("a Conversation created after null-context admission cannot grant old dispatch authority", async () => {
  const owned = await fixture();
  try {
    const { turn } = await createChangeAdmission(owned.database, buildModelID).admit(
      owned.changeID,
      owned.userID,
      { kind: "change-prompt", commandId: crypto.randomUUID(), text: "Bind absent context too" },
    );
    const store = createAgentTurnStore(owned.database);
    const owner = await store.claimPending(turn.id);
    if (!owner?.ownerToken) throw new Error("Owned claim required");
    expect(owner.authority).toMatchObject({ conversationVersion: null });
    await buildConversation(owned);
    expect(await store.beginDispatch(turn.id, owner.ownerToken)).toBeNull();
  } finally {
    await owned.dispose();
  }
});

test("pending Build loses approval after a newer Requirement Revision", async () => {
  const owned = await fixture();
  try {
    const { turn } = await createChangeAdmission(owned.database, buildModelID).admit(
      owned.changeID,
      owned.userID,
      { kind: "change-prompt", commandId: crypto.randomUUID(), text: "Require current approval" },
    );
    const store = createAgentTurnStore(owned.database);
    const owner = await store.claimPending(turn.id);
    if (!owner?.ownerToken) throw new Error("Owned claim required");
    await owned.database.client.begin((sql) => newerRequirements(sql, owned));
    expect(await store.validateExecution(turn.id, owner.ownerToken)).toBe(false);
    expect(await store.beginDispatch(turn.id, owner.ownerToken)).toBeNull();
    expect(owned.requests()).toBe(0);
  } finally {
    await owned.dispose();
  }
});

test("controller shutdown joins held work without settling its lost outcome", async () => {
  const owned = await fixture();
  const controller = owned.controller();
  const commandID = crypto.randomUUID();
  let joined = false;
  let shutdown: Promise<void> | undefined;
  try {
    await controller.prompt(owned.changeID, "Join this held dispatch", owned.userID, commandID);
    await owned.requested;
    shutdown = controller.shutdown().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    owned.release();
    await shutdown;
    expect(joined).toBe(true);
    expect((await owned.turn(commandID))?.state).toBe("dispatching");
    expect(owned.commitCalls).toEqual([]);
    await controller.recover();
    expect(owned.requests()).toBe(1);
  } finally {
    owned.release();
    await shutdown;
    await owned.dispose();
  }
});

test("owned fixture joins held work and cleans up even when Stop persistence throws", async () => {
  const owned = await fixture();
  const checking = createDatabase();
  await owned
    .controller()
    .prompt(
      owned.changeID,
      "Held work during failed Stop teardown",
      owned.userID,
      crypto.randomUUID(),
    );
  await owned.requested;
  const begin = owned.database.client.begin.bind(owned.database.client);
  const end = owned.database.client.end.bind(owned.database.client);
  let begins = 0;
  let ended = false;
  Object.defineProperty(owned.database.client, "begin", {
    value: (callback: (sql: AgentTurnTransaction) => Promise<unknown>) => {
      if (++begins === 1) return Promise.reject(new Error("Owned Stop persistence failure"));
      return begin(callback);
    },
  });
  Object.defineProperty(owned.database.client, "end", {
    value: async () => {
      await end();
      ended = true;
    },
  });
  try {
    await expect(owned.dispose()).rejects.toThrow("Owned Stop persistence failure");
    expect(ended).toBe(true);
    expect(owned.requests()).toBe(1);
    expect(owned.commitCalls).toEqual([]);
    const projects =
      await checking.client`SELECT id FROM factory.project WHERE id = ${owned.projectID}`;
    expect(projects).toHaveLength(0);
  } finally {
    await checking.client.end();
  }
});

test("execution validation rejects a lease that expires during an authority lock wait", async () => {
  const owned = await fixture();
  const locked = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  let writer: Promise<unknown> | undefined;
  let validation: Promise<boolean> | undefined;
  try {
    const { turn } = await createChangeAdmission(owned.database, buildModelID).admit(
      owned.changeID,
      owned.userID,
      {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "Require live ownership after waiting",
      },
    );
    const store = createAgentTurnStore(owned.database);
    writer = owned.database.client
      .begin(async (sql) => {
        const rows = await sql<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid
        FROM factory.ticket WHERE id = ${owned.ticketID} FOR UPDATE`;
        if (!rows[0]) throw new Error("Owned Ticket lock required");
        locked.resolve(rows[0].pid);
        await release.promise;
      })
      .catch((cause: unknown) => {
        locked.reject(cause);
        throw cause;
      });
    const blockerPID = await locked.promise;
    const owner = await store.claimPending(turn.id, 300);
    if (!owner?.ownerToken) throw new Error("Owned claim required");
    validation = store.validateExecution(turn.id, owner.ownerToken);
    await until(
      async () =>
        (
          await owned.database.client`SELECT pid FROM pg_stat_activity
      WHERE ${blockerPID} = ANY(pg_blocking_pids(pid))`
        ).length > 0,
    );
    await until(async () => {
      const rows = await owned.database.client<Array<{ expired: boolean }>>`
        SELECT owner_expires_at <= clock_timestamp() AS expired FROM factory.agent_turn WHERE id = ${turn.id}`;
      return rows[0]?.expired === true;
    });
    release.resolve();
    await writer;
    expect(await validation).toBe(false);
  } finally {
    release.resolve();
    await writer?.catch(() => {});
    await validation?.catch(() => {});
    await owned.dispose();
  }
});

test("pending recovery checks authority before starting compute", async () => {
  const owned = await fixture();
  let starts = 0;
  try {
    const conversationID = await buildConversation(owned);
    const { turn } = await createChangeAdmission(owned.database, buildModelID).admit(
      owned.changeID,
      owned.userID,
      { kind: "change-start", commandId: crypto.randomUUID() },
    );
    await modeRoundTrip(owned, conversationID);
    await owned.database
      .client`UPDATE factory.change SET runtime_attempt_id = NULL WHERE id = ${owned.changeID}`;
    await owned
      .controller(async () => {
        starts += 1;
        return null;
      })
      .recover();
    await until(async () => (await owned.turn(turn.commandId))?.state === "failed");
    expect(starts).toBe(0);
    expect(owned.requests()).toBe(0);
  } finally {
    await owned.dispose();
  }
});

test("Build rechecks authority after Session lookup and before prompt submission", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  try {
    const conversationID = await buildConversation(owned);
    const request = owned.hub.request.bind(owned.hub);
    owned.hub.request = async (attempt, channel, input, path) => {
      const response = await request(attempt, channel, input, path);
      if (new URL(input.url).pathname.endsWith(`/${owned.sessionID}`))
        await modeRoundTrip(owned, conversationID);
      return response;
    };
    await owned
      .controller()
      .prompt(owned.changeID, "Do not submit stale authority", owned.userID, commandID);
    await until(async () => (await owned.turn(commandID))?.state === "uncertain");
    expect(owned.requests()).toBe(0);
    expect(owned.commitCalls).toHaveLength(0);
  } finally {
    await owned.dispose();
  }
});

test("a late old prompt response cannot interrupt a newer running Turn", async () => {
  const owned = await fixture();
  const firstID = crypto.randomUUID();
  const secondID = crypto.randomUUID();
  const releaseFirst = Promise.withResolvers<void>();
  const firstReturned = Promise.withResolvers<void>();
  const request = owned.hub.request.bind(owned.hub);
  let promptCalls = 0;
  owned.hub.request = async (attempt, channel, input, path) => {
    const first = new URL(input.url).pathname.endsWith("/prompt") && ++promptCalls === 1;
    const response = await request(attempt, channel, input, path);
    if (first) {
      await releaseFirst.promise;
      firstReturned.resolve();
    }
    return response;
  };
  try {
    owned.acceptResponse();
    await owned.controller().prompt(owned.changeID, "Old work", owned.userID, firstID);
    await owned.requested;
    await owned.controller().stop(owned.changeID);
    const stoppedInterrupts = owned.interrupts();
    await owned.controller().prompt(owned.changeID, "New work", owned.userID, secondID);
    await until(async () => owned.requests() === 2);
    owned.release();
    await until(async () => (await owned.turn(secondID))?.state === "running");
    releaseFirst.resolve();
    await firstReturned.promise;
    await Bun.sleep(30);
    expect((await owned.turn(firstID))?.state).toBe("stopped");
    expect((await owned.turn(secondID))?.state).toBe("running");
    expect(owned.interrupts()).toBe(stoppedInterrupts);
    expect((await owned.controller().get(owned.changeID)).turn?.commandId).toBe(secondID);
  } finally {
    releaseFirst.resolve();
    await owned.controller().stop(owned.changeID);
    await owned.dispose();
  }
});

test("lost accepted prompts are not blindly submitted again", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  try {
    const first = owned
      .controller()
      .prompt(owned.changeID, "Same intended input", owned.userID, commandID);
    await owned.requested;
    owned.release();
    await first.catch(() => {});
    await owned
      .controller()
      .prompt(owned.changeID, "Same intended input", owned.userID, commandID)
      .catch(() => {});
    expect(owned.requests()).toBe(1);
    await until(async () => (await owned.turn(commandID))?.state === "uncertain");
    expect(await owned.turn(commandID)).toMatchObject({
      input: { text: "Same intended input" },
      state: "uncertain",
    });
    await expect(
      owned.controller().prompt(owned.changeID, "Different input", owned.userID, commandID),
    ).rejects.toMatchObject({ code: "conflict" });
    const original = await owned.turn(commandID);
    if (!original) throw new Error("Uncertain turn required");
    await expect(
      Promise.resolve(owned.database.client`INSERT INTO factory.agent_turn(
      id, command_id, project_id, ticket_id, conversation_id, change_id, created_by, input, input_digest, authority
    ) SELECT ${crypto.randomUUID()}, ${crypto.randomUUID()}, project_id, ticket_id, conversation_id, change_id,
      created_by, input, input_digest, authority FROM factory.agent_turn WHERE id = ${original.id}`),
    ).rejects.toMatchObject({
      code: "23505",
      constraint_name: "agent_turn_unresolved_change_boundary_uidx",
    });
    await expect(
      owned.controller().prompt(owned.changeID, "New command", owned.userID, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "conflict" });
  } finally {
    await owned.dispose();
  }
});

test("successful outcome and exact-turn commit intent settle together", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  try {
    owned.finish();
    await owned
      .controller()
      .prompt(owned.changeID, "Complete this implementation", owned.userID, commandID);
    await owned.requested;
    owned.release();
    await until(async () => {
      const view = await owned.controller().get(owned.changeID);
      if (view.state === "failed") throw new Error(`Owned completion failed: ${view.lastError}`);
      return view.state === "committed";
    });
    expect(await owned.turn(commandID)).toMatchObject({ state: "completed" });
    expect(owned.commitCalls).toEqual(["git-prepare-commit", "git-push"]);
    const turn = await owned.turn(commandID);
    if (!turn) throw new Error("Completed turn required");
    const commits = await owned.database.client<
      Array<{ id: string; state: string }>
    >`SELECT id, state FROM factory.change_commit_operation WHERE change_id = ${owned.changeID}`;
    expect([...commits]).toEqual([{ id: turn.id, state: "succeeded" }]);
    await owned
      .controller()
      .prompt(owned.changeID, "Complete this implementation", owned.userID, commandID);
    expect(owned.requests()).toBe(1);
    expect(owned.commitCalls).toHaveLength(2);
  } finally {
    await owned.dispose();
  }
});

test.each([
  "I could not finish the integration and tests within this turn.",
  [
    "```factory-build-result",
    JSON.stringify({
      status: "incomplete",
      summary: "The controller is not integrated.",
      criteria: [],
      checks: [],
      remaining: ["Connect the component and run the normal checks."],
    }),
    "```",
  ].join("\n"),
])(
  "a frozen report-contract admission still cannot submit an unfinished native stop: %s",
  async (answer) => {
    const owned = await fixture();
    const commandID = crypto.randomUUID();
    try {
      owned.finish(answer);
      const admission = createChangeAdmission(owned.database, buildModelID);
      const accepted = await admission.admit(owned.changeID, owned.userID, {
        kind: "change-prompt",
        commandId: commandID,
        text: "Finish the approved implementation",
      });
      // Model a retained, never-dispatched historical admission through its
      // fixture input. Production code cannot rewrite admitted instructions.
      await owned.database.client.begin(async (sql) => {
        await sql`SET LOCAL session_replication_role = 'replica'`;
        await sql`UPDATE factory.change_agent_turn_intent
        SET prompt_text=prompt_text || E'\\nFactory Build completion report v1: criteria=1'
        WHERE turn_id=${accepted.turn.id}`;
        await sql`UPDATE factory.agent_turn SET authority=authority-'submissionPolicy'
          WHERE id=${accepted.turn.id}`;
      });
      await owned
        .controller()
        .prompt(owned.changeID, "Finish the approved implementation", owned.userID, commandID);
      await owned.controller().recover();
      await owned.requested;
      owned.release();
      await until(async () => (await owned.controller().get(owned.changeID)).state === "failed");
      expect(await owned.turn(commandID)).toMatchObject({
        state: "failed",
        summary: expect.stringContaining("Implementation incomplete"),
      });
      expect(owned.commitCalls).toEqual([]);
      expect(
        await owned.database
          .client`SELECT id FROM factory.change_commit_operation WHERE change_id = ${owned.changeID}`,
      ).toHaveLength(0);
      expect(owned.requests()).toBe(1);
    } finally {
      await owned.dispose();
    }
  },
);

test("a new goal submits ordinary native output for Verification without treating submission as Delivery", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  try {
    owned.finish("Changed the implementation and ran its checks. Review the remaining UI details.");
    await owned
      .controller()
      .prompt(owned.changeID, "Work toward the approved goal", owned.userID, commandID);
    await owned.requested;
    owned.release();
    await until(async () => (await owned.controller().get(owned.changeID)).state === "committed");
    expect(await owned.turn(commandID)).toMatchObject({
      state: "completed",
      summary: expect.stringContaining("not approved for Delivery"),
    });
    expect(owned.commitCalls).toEqual(["git-prepare-commit", "git-push"]);
    expect(
      await owned.database.client`SELECT id FROM factory.delivery_approval
      WHERE change_id=${owned.changeID}`,
    ).toHaveLength(0);
    expect(owned.requests()).toBe(1);
  } finally {
    await owned.dispose();
  }
});

test("Start admission precedes runtime startup and Stop fences a late startup response", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  const starting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let starts = 0;
  const controller = owned.controller(async () => {
    starts += 1;
    starting.resolve();
    await release.promise;
    return null;
  });
  try {
    await owned.database
      .client`UPDATE factory.runtime_attempt SET state = 'starting' WHERE id = ${owned.attemptID}`;
    await owned.database
      .client`DELETE FROM factory.change_agent_session WHERE change_id = ${owned.changeID}`;
    const accepted = await controller.start(owned.changeID, owned.userID, commandID);
    await starting.promise;
    expect(accepted).toMatchObject({ state: "starting", turn: { commandId: commandID } });
    expect(await owned.turn(commandID)).toMatchObject({ state: "pending" });
    expect(await controller.start(owned.changeID, owned.userID, commandID)).toMatchObject({
      turn: { id: accepted.turn?.id },
    });
    expect(starts).toBe(1);
    expect(await controller.stop(owned.changeID)).toMatchObject({ state: "stopped" });
    release.resolve();
    await Bun.sleep(30);
    expect(await owned.turn(commandID)).toMatchObject({ state: "stopped" });
    expect(owned.requests()).toBe(0);
  } finally {
    release.resolve();
    await owned.dispose();
  }
});

test("automatic repair cannot resume a persisted Stop", async () => {
  const owned = await fixture();
  try {
    await owned.controller().stop(owned.changeID);
    await expect(
      owned.controller().prompt(owned.changeID, "Repair", owned.userID, crypto.randomUUID(), true),
    ).rejects.toThrow("Automatic repair is paused");
    expect(owned.requests()).toBe(0);
    expect(
      await owned.database
        .client`SELECT id FROM factory.agent_turn WHERE project_id = ${owned.projectID}`,
    ).toHaveLength(0);
  } finally {
    await owned.dispose();
  }
});

test("recorded pending input recovers through another controller without a duplicate prompt", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  try {
    const admitted = await createChangeAdmission(owned.database, buildModelID).admit(
      owned.changeID,
      owned.userID,
      {
        kind: "change-prompt",
        commandId: commandID,
        text: "Persist this input before process loss",
      },
    );
    const recovering = owned.controller();
    await recovering.recover();
    await owned.requested;
    await owned.controller().recover();
    expect(owned.requests()).toBe(1);
    const retainedIntent = await createChangeAdmission(owned.database, buildModelID).intent(
      admitted.turn.id,
    );
    expect(owned.payloads[0]).toMatchObject({
      id: `msg_factory_${admitted.turn.id.replaceAll("-", "")}`,
      text: retainedIntent.text,
      delivery: "queue",
    });
    owned.release();
    await until(async () => (await owned.turn(commandID))?.state === "uncertain");
    const intent = await owned.database.client<
      Array<{ text: string }>
    >`SELECT prompt_text AS text FROM factory.change_agent_turn_intent WHERE turn_id = ${admitted.turn.id}`;
    expect(intent[0]?.text).toBe(retainedIntent.text);
    expect(retainedIntent.text).toStartWith("Persist this input before process loss\n\n");
    expect(retainedIntent.text).toContain("factory_browser_browser_open");
    expect(retainedIntent.text).not.toContain("browser-client");
    await expect(
      Promise.resolve(
        owned.database
          .client`UPDATE factory.change_agent_turn_intent SET prompt_text = 'Rewritten input' WHERE turn_id = ${admitted.turn.id}`,
      ),
    ).rejects.toThrow("dispatch intent is immutable");
  } finally {
    await owned.dispose();
  }
});

test("Stop fences a late accepted prompt and its running state", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  try {
    owned.acceptResponse();
    await owned
      .controller()
      .prompt(owned.changeID, "Stop this admitted work", owned.userID, commandID);
    await owned.requested;
    await owned.controller().stop(owned.changeID);
    const confirmationReads = owned.statusReads();
    owned.release();
    await Bun.sleep(30);
    expect(await owned.turn(commandID)).toMatchObject({ state: "stopped" });
    expect(await owned.controller().get(owned.changeID)).toMatchObject({
      state: "stopped",
      turn: { state: "stopped" },
    });
    // Native Stop confirmation may read status. A late prompt must not resume monitoring.
    expect(owned.statusReads()).toBe(confirmationReads);
  } finally {
    await owned.dispose();
  }
});

test("a running owner waits for Connector reconnect and retains Stop", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  try {
    owned.acceptResponse();
    await owned.controller().prompt(owned.changeID, "Observe reconnect", owned.userID, commandID);
    await owned.requested;
    owned.hub.connected = () => false;
    owned.release();
    await until(async () => (await owned.turn(commandID))?.state === "running");
    await Bun.sleep(1_050);
    expect(await owned.turn(commandID)).toMatchObject({ state: "running" });
    expect(owned.statusReads()).toBe(0);
    await owned.controller().stop(owned.changeID);
    owned.hub.connected = () => true;
    await Bun.sleep(1_050);
    expect(await owned.turn(commandID)).toMatchObject({ state: "stopped" });
  } finally {
    await owned.dispose();
  }
}, 15_000);

test("bootstrap intent retains the full valid Requirement content rather than truncating it", async () => {
  const canonical = canonicalRequirementContent({
    summary: "s".repeat(10_000),
    acceptanceCriteria: Array.from({ length: 100 }, (_, i) => `${i}:${"\u0000".repeat(1_996)}`),
    nonGoals: Array.from({ length: 100 }, (_, i) => `${i}:${"\u0001".repeat(1_996)}`),
  });
  const owned = await fixture(canonical);
  try {
    const admitted = await createChangeAdmission(owned.database, "owned-model").admit(
      owned.changeID,
      owned.userID,
      { kind: "change-start", commandId: crypto.randomUUID() },
    );
    const records = await owned.database.client<Array<{ text: string; bootstrap: boolean }>>`
      SELECT prompt_text AS text, bootstrap FROM factory.change_agent_turn_intent WHERE turn_id = ${admitted.turn.id}`;
    expect(records[0]?.text.length).toBeGreaterThan(2_000_000);
    expect(records[0]?.text).toContain(canonical);
    expect(records[0]?.bootstrap).toBe(true);
    expect(owned.requests()).toBe(0);
  } finally {
    await owned.dispose();
  }
});

test("expired dispatch recovers as unresolved and never replays the bootstrap", async () => {
  const owned = await fixture();
  try {
    const accepted = await createChangeAdmission(owned.database, buildModelID).admit(
      owned.changeID,
      owned.userID,
      { kind: "change-start", commandId: crypto.randomUUID() },
    );
    const store = createAgentTurnStore(owned.database);
    const claim = await store.claimPending(accepted.turn.id);
    if (!claim?.ownerToken) throw new Error("Owned dispatch required");
    await store.beginDispatch(claim.id, claim.ownerToken);
    await owned.database
      .client`UPDATE factory.agent_turn SET owner_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${claim.id}`;
    await owned.controller().recover();
    await owned.controller().recover();
    await until(async () => (await owned.turn(accepted.turn.commandId))?.state === "uncertain");
    expect(await owned.turn(accepted.turn.commandId)).toMatchObject({ state: "uncertain" });
    expect(owned.requests()).toBe(0);
    await expect(
      owned.controller().start(owned.changeID, owned.userID, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "conflict" });
  } finally {
    await owned.dispose();
  }
});

test("recovery reattaches exact accepted work after response loss without another prompt", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  try {
    await owned
      .controller()
      .prompt(owned.changeID, "Recover the exact accepted input", owned.userID, commandID);
    await owned.requested;
    owned.release();
    await until(async () => (await owned.turn(commandID))?.state === "uncertain");
    owned.finish();
    await Promise.all([owned.controller().recover(), owned.controller().recover()]);
    await until(async () => (await owned.turn(commandID))?.state === "completed");
    await until(async () => (await owned.controller().get(owned.changeID)).state === "committed");
    expect(owned.requests()).toBe(1);
    expect(await owned.controller().get(owned.changeID)).toMatchObject({ state: "committed" });
    expect(owned.commitCalls).toEqual(["git-prepare-commit", "git-push"]);
    await owned.controller().recover();
    expect(owned.requests()).toBe(1);
    expect(owned.commitCalls).toHaveLength(2);
  } finally {
    await owned.dispose();
  }
});

test.each(["monitor", "recovery"] as const)(
  "%s settles the exact completed input beyond 100 native messages without replay",
  async (phase) => {
    const owned = await fixture();
    const commandID = crypto.randomUUID();
    const controller = owned.controller();
    let earlierReads = 0;
    try {
      if (phase === "monitor") owned.acceptResponse();
      await controller.prompt(
        owned.changeID,
        "Complete this long native turn",
        owned.userID,
        commandID,
      );
      await owned.requested;
      owned.release();
      await until(
        async () =>
          (await owned.turn(commandID))?.state === (phase === "monitor" ? "running" : "uncertain"),
      );
      const request = owned.hub.request.bind(owned.hub);
      owned.hub.request = async (attempt, channel, input, path) => {
        const response = await request(attempt, channel, input, path);
        const url = new URL(input.url);
        if (!url.pathname.endsWith("/message")) return response;
        const page = (await response.json()) as { data: Array<{ type: string }> };
        const prompt = page.data.find((message) => message.type === "user");
        if (!prompt) return Response.json(page);
        if (url.searchParams.get("cursor") === "owned-earlier-messages") {
          earlierReads++;
          return Response.json({ data: [prompt], cursor: {} });
        }
        return Response.json({
          data: [
            page.data[0],
            ...Array.from({ length: 99 }, (_, index) => ({
              id: `msg_owned_step_${index}`,
              type: "assistant",
              time: { created: 2, completed: 3 },
              finish: "tool-calls",
              content: [],
            })),
          ],
          cursor: { next: "owned-earlier-messages" },
        });
      };
      owned.finish();
      if (phase === "recovery") await owned.controller().recover();
      await until(
        async () => (await controller.get(owned.changeID, undefined, false)).state === "committed",
        300,
      );
      expect((await owned.turn(commandID))?.state).toBe("completed");
      expect(earlierReads).toBeGreaterThan(0);
      expect(owned.requests()).toBe(1);
      expect(owned.commitCalls).toEqual(["git-prepare-commit", "git-push"]);
    } finally {
      await owned.dispose();
    }
  },
);

test.each(["session", "messages", "activity", "usage", "guidance"] as const)(
  "recovery survives a transient %s read failure without another prompt",
  async (boundary) => {
    const owned = await fixture();
    const commandID = crypto.randomUUID();
    let failures = 0;
    try {
      await owned
        .controller()
        .prompt(owned.changeID, "Recover after a read disconnect", owned.userID, commandID);
      await owned.requested;
      owned.release();
      await until(async () => (await owned.turn(commandID))?.state === "uncertain");
      owned.finish();
      const request = owned.hub.request.bind(owned.hub);
      owned.hub.request = async (attempt, channel, input, path) => {
        const pathname = new URL(input.url).pathname;
        const target =
          boundary === "session"
            ? `/api/session/${owned.sessionID}`
            : boundary === "messages"
              ? `/api/session/${owned.sessionID}/message`
              : boundary === "activity"
                ? "/api/session/active"
                : boundary === "usage"
                  ? `/api/experimental/session/${owned.sessionID}/log`
                  : `/api/experimental/session/${owned.sessionID}/instructions/entries`;
        if (input.method === "GET" && pathname === target && failures === 0) {
          failures++;
          throw new Error("Owned transient read disconnect");
        }
        return request(attempt, channel, input, path);
      };
      const controller = owned.controller();
      await controller.recover();
      await until(
        async () => (await controller.get(owned.changeID, undefined, false)).state === "committed",
        300,
      );
      expect(failures).toBe(1);
      expect((await owned.turn(commandID))?.state).toBe("completed");
      expect(owned.requests()).toBe(1);
      expect(owned.commitCalls).toEqual(["git-prepare-commit", "git-push"]);
    } finally {
      await owned.dispose();
    }
  },
);

test("Stop fences recovery while read-only reconnect is waiting", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  const disconnected = Promise.withResolvers<void>();
  try {
    await owned
      .controller()
      .prompt(owned.changeID, "Stop this reconnecting input", owned.userID, commandID);
    await owned.requested;
    owned.release();
    await until(async () => (await owned.turn(commandID))?.state === "uncertain");
    owned.finish();
    const request = owned.hub.request.bind(owned.hub);
    owned.hub.request = async (attempt, channel, input, path) => {
      if (new URL(input.url).pathname === `/api/session/${owned.sessionID}`) {
        disconnected.resolve();
        throw new Error("Owned status transport remains disconnected");
      }
      return request(attempt, channel, input, path);
    };
    const controller = owned.controller();
    await controller.recover();
    await disconnected.promise;
    await controller.stop(owned.changeID);
    await controller.shutdown();
    expect((await owned.turn(commandID))?.state).toBe("stopped");
    expect(owned.requests()).toBe(1);
    expect(owned.commitCalls).toHaveLength(0);
  } finally {
    await owned.dispose();
  }
});

test("recovery refuses a replaced runtime generation without prompting or committing", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  try {
    await owned
      .controller()
      .prompt(owned.changeID, "Retain the exact generation", owned.userID, commandID);
    await owned.requested;
    owned.release();
    await until(async () => (await owned.turn(commandID))?.state === "uncertain");
    owned.finish();
    await owned.database
      .client`UPDATE factory.change SET runtime_attempt_id = NULL WHERE id = ${owned.changeID}`;
    await owned.controller().recover();
    await until(async () => {
      const view = await owned.controller().get(owned.changeID);
      return (
        view.turn?.state === "uncertain" && !!view.turn.summary?.includes("runtime generation")
      );
    });
    expect(owned.requests()).toBe(1);
    expect(owned.commitCalls).toHaveLength(0);
  } finally {
    await owned.dispose();
  }
});

test("competing controller commands persist only the accepted Build input", async () => {
  const owned = await fixture();
  const commandID = crypto.randomUUID();
  try {
    const first = owned
      .controller()
      .prompt(owned.changeID, "Accepted Build input", owned.userID, commandID);
    await owned.requested;
    await expect(
      owned
        .controller()
        .prompt(owned.changeID, "Rejected Build input", owned.userID, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await owned.turn(commandID)).toMatchObject({ input: { text: "Accepted Build input" } });
    expect(owned.requests()).toBe(1);
    owned.release();
    await first.catch(() => {});
    await until(async () => (await owned.turn(commandID))?.state === "uncertain");
  } finally {
    await owned.dispose();
  }
});

test.each(["unchanged", "Stop", "mode version", "generation", "invalid admission"] as const)(
  "retained queued input before promotion: %s",
  async (boundary) => {
    const owned = await fixture();
    const commandID = crypto.randomUUID();
    let observations = 0;
    let wakes = 0;
    try {
      const conversationID = boundary === "mode version" ? await buildConversation(owned) : null;
      const admission = createChangeAdmission(owned.database, buildModelID);
      const { turn } = await admission.admit(owned.changeID, owned.userID, {
        kind: "change-prompt",
        commandId: commandID,
        text: "Retain this queued input across response loss",
      });
      const store = createAgentTurnStore(owned.database);
      const claimed = await store.claimPending(turn.id);
      if (!claimed?.ownerToken) throw new Error("Owned dispatch required");
      await store.beginDispatch(turn.id, claimed.ownerToken);
      await owned.database.client`UPDATE factory.change_agent_turn_intent
      SET runtime_attempt_id = ${owned.attemptID} WHERE turn_id = ${turn.id}`;
      await owned.database.client`UPDATE factory.change_agent_session
      SET state = 'starting', active_turn_id = ${turn.id} WHERE change_id = ${owned.changeID}`;
      await owned.database.client`UPDATE factory.agent_turn
      SET owner_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${turn.id}`;
      const intent = await admission.intent(turn.id);
      const request = owned.hub.request.bind(owned.hub);
      owned.hub.request = async (attempt, channel, input, path) => {
        if (new URL(input.url).pathname.endsWith("/inbox"))
          return Response.json({
            data:
              observations && !wakes
                ? [
                    {
                      id: intent.promptID,
                      sessionID: intent.sessionID,
                      type: "user",
                      payload: { text: intent.text },
                      delivery: "queue",
                      time: { created: 1 },
                    },
                  ]
                : [],
          });
        if (new URL(input.url).pathname.endsWith("/prompt")) {
          const body = (await input.json()) as {
            id: string;
            text: string;
            resume: boolean;
          };
          expect(body.id).toBe(intent.promptID);
          expect(body.text).toBe(intent.text);
          if (body.resume) wakes += 1;
          else observations += 1;
          if (!body.resume) {
            if (boundary === "Stop") await owned.controller().stop(owned.changeID);
            if (conversationID) await modeRoundTrip(owned, conversationID);
            if (boundary === "generation")
              await owned.database.client`UPDATE factory.change SET runtime_attempt_id = NULL
              WHERE id = ${owned.changeID}`;
          }
          return Response.json({
            data: {
              id: boundary === "invalid admission" ? "msg_wrong" : intent.promptID,
              sessionID: intent.sessionID,
              payload: { text: intent.text },
              type: "user",
              delivery: "queue",
              time: { created: 1 },
              ...(wakes ? { promotedSeq: 2 } : {}),
            },
          });
        }
        if (new URL(input.url).pathname.endsWith("/message")) {
          return Response.json({
            data: wakes
              ? [
                  {
                    id: `${intent.promptID}_assistant`,
                    type: "assistant",
                    time: { created: 2, completed: 3 },
                    finish: "stop",
                    content: [{ type: "text", text: owned.completionText }],
                  },
                  { id: intent.promptID, type: "user", text: intent.text, time: { created: 1 } },
                ]
              : [
                  {
                    id: "msg_owned_boundary",
                    type: "agent-selected",
                    agent: "build",
                    time: { created: 0 },
                  },
                ],
          });
        }
        return request(attempt, channel, input, path);
      };
      await Promise.all([owned.controller().recover(), owned.controller().recover()]);
      await until(async () =>
        ["committed", "failed", "stopped"].includes(
          (await owned.controller().get(owned.changeID)).state,
        ),
      );
      expect(await owned.controller().get(owned.changeID)).toMatchObject({
        state: boundary === "unchanged" ? "committed" : boundary === "Stop" ? "stopped" : "failed",
      });
      // Competing read-only recovery owners may briefly reclaim the same
      // uncertain record. Assert the settlement snapshot we actually observed,
      // not a second read that can race the next owner's authority check.
      let observedSettlement: string | undefined;
      await until(async () => {
        observedSettlement = (await owned.turn(commandID))?.state;
        return ["completed", "stopped", "uncertain"].includes(observedSettlement ?? "");
      }, 300);
      expect(observedSettlement).toBe(
        boundary === "unchanged" ? "completed" : boundary === "Stop" ? "stopped" : "uncertain",
      );
      expect(observations).toBeGreaterThan(0);
      expect(wakes).toBe(boundary === "unchanged" ? 1 : 0);
      expect(owned.commitCalls).toEqual(
        boundary === "unchanged" ? ["git-prepare-commit", "git-push"] : [],
      );
    } finally {
      await owned.dispose();
    }
  },
);
