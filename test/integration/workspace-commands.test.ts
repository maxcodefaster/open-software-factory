import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { createWorkspaceCommands } from "../../apps/factory/src/workspace/commands";
import { createWorkspaceComputeAccess } from "../../apps/factory/src/workspace/compute-access";
import { createWorkspaceSharing } from "../../apps/factory/src/workspace/sharing";
import { eventually } from "../fixtures/factory-process";
import { startSubstrateFixtureWorkspace, substrateFixture } from "../fixtures/substrate";

async function commandFixture(loseStartReply = false) {
  const fixture = await substrateFixture();
  const { database, userID: owner, projectID: project, workspaceID, attemptID, hub } = fixture;
  const guest = crypto.randomUUID();
  await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${guest},'Command fixture',${`${guest}@factory.invalid`})`;
  await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${project},${guest},'developer',${owner})`;
  const runtime = await startSubstrateFixtureWorkspace(fixture).catch(async (cause) => {
    await fixture.dispose();
    throw cause;
  });
  type Native = {
    id: string;
    digest: string;
    state: string;
    pid: number;
    startedAt: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    stdoutFrom: number;
    stderrFrom: number;
    stdoutNext: number;
    stderrNext: number;
    outputLost: boolean;
  };
  const native = new Map<string, Native>();
  let starts = 0;
  let terminalInputs = 0;
  const parent = {
    data: { kind: "connector", role: "parent", attemptID, generation: 1 },
    close() {},
    send: () => 1,
  } as unknown as ServerWebSocket<RuntimeSocketData>;
  const child = {
    data: { kind: "connector", role: "child", attemptID, generation: 1 },
    close() {},
    send(value: string) {
      const message = JSON.parse(value) as { operationId: string; action: string; data: string };
      const input = JSON.parse(message.data) as { id: string; digest: string };
      if (message.action === "command-start" || message.action === "pty-open") {
        starts++;
        native.set(input.id, {
          id: input.id,
          digest: input.digest,
          state: "running",
          pid: 123,
          startedAt: new Date().toISOString(),
          stdoutFrom: 0,
          stderrFrom: 0,
          stdoutNext: 0,
          stderrNext: 0,
          outputLost: false,
        });
        if (loseStartReply) throw new Error("lost command acknowledgement after execution");
      }
      const result = native.get(input.id);
      if (!result) throw new Error("unknown fixture command");
      if (message.action === "command-cancel" || message.action === "pty-close")
        result.state = "cancelled";
      if (message.action === "pty-input") terminalInputs++;
      queueMicrotask(() =>
        hub.message(
          child,
          JSON.stringify({
            type: "operation-response",
            operationId: message.operationId,
            action: message.action,
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
  const commands = createWorkspaceCommands(database, hub, runtime, "command-fixture-key");
  const sharing = createWorkspaceSharing(database, () => {});
  return {
    database,
    owner,
    guest,
    workspaceID,
    attemptID,
    commands,
    native,
    hub,
    runtime,
    child,
    sharing,
    starts: () => starts,
    terminalInputs: () => terminalInputs,
    async dispose() {
      await commands.close();
      hub.revoke(attemptID);
      await fixture.dispose();
    },
  };
}

test("command intent is exact, credential-free and never dispatches twice", async () => {
  const f = await commandFixture();
  const requestID = crypto.randomUUID();
  const input = {
    requestID,
    workspaceID: f.workspaceID,
    command: "printf command-proof",
    env: { API_KEY: "fixture-value-must-not-be-retained" },
  };
  try {
    const result = await f.commands.start(f.owner, input);
    expect(result.state).toBe("running");
    expect(await f.commands.start(f.owner, input)).toEqual(result);
    expect(f.starts()).toBe(1);
    await expect(
      f.commands.start(f.owner, { ...input, command: "different-command" }),
    ).rejects.toThrow("different input");
    const [stored] = await f.database.client<
      { record: string }[]
    >`SELECT row_to_json(command)::text AS record FROM factory.operation command WHERE id=${requestID} AND kind='workspace.command'`;
    expect(stored?.record).not.toContain(input.env.API_KEY);
    expect(stored?.record).not.toContain(input.command);
    const observed = f.native.get(requestID);
    if (!observed) throw new Error("Native fixture command missing");
    observed.state = "exited";
    observed.exitCode = 0;
    observed.stdout = Buffer.from("native output").toString("base64");
    observed.stdoutNext = 13;
    expect((await f.commands.status(f.owner, requestID)).state).toBe("exited");
    expect(
      (await f.commands.read(f.owner, { commandID: requestID, stdout: 0, stderr: 0 })).stdout,
    ).toBe("native output");
    expect(f.starts()).toBe(1);
  } finally {
    await f.dispose();
  }
}, 30000);

test.each(["shell", "terminal"] as const)(
  "%s output never combines an earlier output page with a later completed state",
  async (kind) => {
    const f = await commandFixture();
    const requestID = crypto.randomUUID();
    try {
      await f.commands.start(
        f.owner,
        { requestID, workspaceID: f.workspaceID, command: "printf completed-output", env: {} },
        kind,
      );
      const request = f.hub.childRequest.bind(f.hub);
      let advanced = false;
      f.hub.childRequest = async (...args) => {
        const snapshot = await request(...args);
        if (
          !advanced &&
          args[1]["action"] === (kind === "terminal" ? "pty-read" : "command-read")
        ) {
          advanced = true;
          const previous = f.native.get(requestID);
          if (!previous) throw new Error("Original fixture command missing");
          const final = {
            ...previous,
            state: "exited",
            exitCode: 0,
            stdout: Buffer.from("completed-output").toString("base64"),
            stdoutNext: Buffer.byteLength("completed-output"),
          };
          f.native.set(requestID, final);
          f.hub.message(
            f.child,
            JSON.stringify({ type: "command-state", commandCount: 0, data: JSON.stringify(final) }),
          );
          await eventually(
            async () => {
              const [row] = await f.database
                .client`SELECT state FROM factory.operation WHERE id=${requestID} AND kind='workspace.command'`;
              return row?.["state"];
            },
            (state) => state === "exited",
            "The newer completion event was not retained",
          );
        }
        return snapshot;
      };
      const earlier = await f.commands.read(
        f.owner,
        { commandID: requestID, stdout: 0, stderr: 0 },
        kind,
      );
      expect(earlier).toMatchObject({
        state: "running",
        exitCode: null,
        completedAt: null,
        stdout: "",
        stdoutNext: 0,
      });
      expect((await f.commands.status(f.owner, requestID)).state).toBe("exited");
      if (!("stdoutNext" in earlier) || !("stderrNext" in earlier))
        throw new Error("The original output page is unavailable");
      const completed = await f.commands.read(
        f.owner,
        { commandID: requestID, stdout: earlier.stdoutNext, stderr: earlier.stderrNext },
        kind,
      );
      expect(completed).toMatchObject({
        state: "exited",
        exitCode: 0,
        stdout: "completed-output",
        stdoutNext: Buffer.byteLength("completed-output"),
        outputLost: false,
      });
      expect(f.starts()).toBe(1);
    } finally {
      await f.dispose();
    }
  },
  30000,
);

test.each(["paused", "starting"] as const)(
  "command output demand resumes exact %s compute without replaying the command",
  async (state) => {
    const f = await commandFixture();
    let resumes = 0;
    const baseline = await f.runtime.get(f.attemptID);
    const commands = createWorkspaceCommands(
      f.database,
      f.hub,
      {
        ...f.runtime,
        start: async () => {
          resumes++;
          await f.database
            .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
          f.hub.connected = () => true;
          return f.runtime.get(f.attemptID);
        },
        get: async () => {
          const [current] = await f.database.client<{ state: string }[]>`
          SELECT state FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
          return baseline && current ? { ...baseline, state: current.state } : null;
        },
      },
      "command-fixture-key",
    );
    try {
      const id = crypto.randomUUID();
      await commands.start(f.owner, {
        requestID: id,
        workspaceID: f.workspaceID,
        command: "owned execution",
        env: {},
      });
      await f.database
        .client`UPDATE factory.runtime_attempt SET state=${state} WHERE id=${f.attemptID}`;
      if (state === "starting")
        await f.database.client`INSERT INTO factory.operation(
          id,kind,scope_type,scope_id,idempotency_key,state,payload)
          VALUES(${crypto.randomUUID()},'runtime.compute_wait','runtime_attempt',${f.attemptID},
            ${`runtime.compute_wait:${f.attemptID}`},'waiting',jsonb_build_object('reason','compute-capacity'))`;
      f.hub.connected = () => false;
      await commands.status(f.owner, id);
      expect(resumes).toBe(0);
      expect(
        (await commands.read(f.owner, { commandID: id, stdout: 0, stderr: 0 })).outputAvailable,
      ).toBe(true);
      expect(resumes).toBe(1);
      expect(f.starts()).toBe(1);
    } finally {
      await commands.close();
      await f.dispose();
    }
  },
  30000,
);

test("command demand continues a capacity-waiting startup before admitting its command", async () => {
  const f = await commandFixture();
  let resumes = 0;
  const commands = createWorkspaceCommands(
    f.database,
    f.hub,
    {
      ...f.runtime,
      start: async () => {
        resumes++;
        await f.database
          .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
        f.hub.connected = () => true;
        return f.runtime.get(f.attemptID);
      },
      get: async (id) => {
        if (!resumes)
          throw Error("Capacity-waiting startup was polled without its authorized continuation");
        return f.runtime.get(id);
      },
    },
    "command-fixture-key",
  );
  try {
    await eventually(
      () => f.database.client`SELECT state FROM factory.runtime_attempt WHERE id=${f.attemptID}`,
      (rows) => rows[0]?.["state"] === "ready",
      "Initial controlled Connector readiness was not settled",
    );
    f.hub.ready = () => resumes > 0;
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${f.attemptID}`;
    await f.database.client`INSERT INTO factory.operation(
      id,kind,scope_type,scope_id,idempotency_key,state,payload)
      VALUES(${crypto.randomUUID()},'runtime.compute_wait','runtime_attempt',${f.attemptID},
        ${`runtime.compute_wait:${f.attemptID}`},'waiting',jsonb_build_object('reason','compute-capacity'))`;
    f.hub.connected = () => false;
    await commands.start(f.owner, {
      requestID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      command: "owned execution",
      env: {},
    });
    expect(resumes).toBe(1);
    expect(f.starts()).toBe(1);
  } finally {
    await commands.close();
    await f.dispose();
  }
}, 30000);

test("unknown suspended startup refuses demand promptly without admitting a command", async () => {
  const f = await commandFixture();
  const commands = createWorkspaceCommands(
    f.database,
    f.hub,
    {
      ...f.runtime,
      get: async (id) => {
        const observed = await f.runtime.get(id);
        return observed
          ? {
              ...observed,
              state: "starting",
              native: {
                engine: "substrate" as const,
                state: "ACTOR_STATE_SUSPENDED",
                coldRestart: true as const,
                portable: false as const,
                sourceHandoff: "pending" as const,
              },
            }
          : observed;
      },
    },
    "command-fixture-key",
  );
  const requestID = crypto.randomUUID();
  try {
    f.hub.ready = () => false;
    await expect(
      commands.start(f.owner, {
        requestID,
        workspaceID: f.workspaceID,
        command: "must not execute",
        env: {},
      }),
    ).rejects.toThrow("Compute startup is unconfirmed. No operation was dispatched");
    expect(f.starts()).toBe(0);
    expect([
      ...(await f.database
        .client`SELECT id FROM factory.operation WHERE id=${requestID} AND kind='workspace.command'`),
    ]).toEqual([]);
  } finally {
    await commands.close();
    await f.dispose();
  }
}, 30000);

test("compute demand refuses stopped, failed and foreign handles without dispatch", async () => {
  const f = await commandFixture();
  let preparations = 0;
  const demand = createWorkspaceComputeAccess(
    f.database,
    { ready: () => true, sourceConnected: () => true },
    {
      ...f.runtime,
      start: async () => {
        preparations++;
        throw Error("Refused compute must not start");
      },
      startPersisted: async () => {
        preparations++;
        throw Error("Refused compute must not start");
      },
      resumeForSource: async () => {
        preparations++;
        throw Error("Refused compute must not resume");
      },
    },
    () => false,
  );
  try {
    await expect(demand(f.workspaceID, f.owner, true, crypto.randomUUID())).rejects.toThrow(
      "different Runtime Attempt",
    );
    await expect(
      demand(f.workspaceID, f.owner, false, crypto.randomUUID(), undefined, true),
    ).rejects.toThrow("different Runtime Attempt");
    for (const state of ["stop-intended", "stopping", "stopped", "failed", "cleanup-failed"]) {
      await f.database
        .client`UPDATE factory.runtime_attempt SET state=${state} WHERE id=${f.attemptID}`;
      await expect(demand(f.workspaceID, f.owner)).rejects.toThrow(
        "Start this Workspace explicitly",
      );
      await expect(
        demand(f.workspaceID, f.owner, false, f.attemptID, undefined, true),
      ).rejects.toThrow("Start this Workspace explicitly");
    }
    expect(preparations).toBe(0);
    expect(f.starts()).toBe(0);
    expect(
      await f.database.client`SELECT id FROM factory.operation WHERE kind='workspace.command'`,
    ).toHaveLength(0);
  } finally {
    await f.dispose();
  }
}, 30000);

test("current-file wake never grants personal observation shares compute authority", async () => {
  const f = await commandFixture();
  let resumes = 0;
  const demand = createWorkspaceComputeAccess(
    f.database,
    { ready: () => true, sourceConnected: () => true },
    {
      ...f.runtime,
      resumeForSource: async () => {
        resumes++;
        throw Error("Personal observer must not wake compute");
      },
    },
    () => false,
  );
  try {
    await f.sharing.decide(f.owner, {
      commandID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      userID: f.guest,
      permission: "observe",
      expectedVersion: 0,
    });
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${f.attemptID}`;
    await expect(
      demand(f.workspaceID, f.guest, false, f.attemptID, undefined, true),
    ).rejects.toThrow("shared for observation only");
    expect(resumes).toBe(0);
    expect(f.starts()).toBe(0);
    expect(
      await f.database.client`SELECT id FROM factory.operation WHERE kind='workspace.command'`,
    ).toHaveLength(0);
  } finally {
    await f.dispose();
  }
}, 30000);

test("resumed Source demand waits for saved readiness even when its native transport is already ready", async () => {
  const f = await commandFixture();
  await eventually(
    async () =>
      (
        await f.database.client`SELECT state FROM factory.runtime_attempt WHERE id=${f.attemptID}`
      )[0]?.["state"],
    (state) => state === "ready",
    "Initial controlled readiness did not settle",
  );
  let observed = 0;
  let resolved = false;
  let pending: Promise<string> | undefined;
  const demand = createWorkspaceComputeAccess(
    f.database,
    { ready: () => true, sourceConnected: () => true },
    {
      ...f.runtime,
      start: async () => {
        await f.database
          .client`UPDATE factory.runtime_attempt SET state='starting' WHERE id=${f.attemptID}`;
        return f.runtime.get(f.attemptID);
      },
      get: async (attemptID) => {
        observed++;
        return f.runtime.get(attemptID);
      },
    },
    () => false,
  );
  try {
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${f.attemptID}`;
    pending = demand(f.workspaceID, f.owner).then((value) => {
      resolved = true;
      return value;
    });
    await eventually(
      async () => observed > 0 || resolved,
      (progress) => progress,
      "Source demand did not reach its readiness observation",
    );
    expect(resolved).toBe(false);
    expect(observed).toBeGreaterThan(0);
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
    expect(await pending).toBe(f.attemptID);
    expect(f.starts()).toBe(0);
  } finally {
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${f.attemptID}`;
    await pending;
    await f.dispose();
  }
}, 30000);

test("cancelled Source demand neither starts compute nor authorizes a later file mutation", async () => {
  const f = await commandFixture();
  let resumes = 0;
  const cancelled = new AbortController();
  const demand = createWorkspaceComputeAccess(
    f.database,
    { ready: () => true, sourceConnected: () => true },
    {
      ...f.runtime,
      start: async () => {
        resumes++;
        cancelled.abort(new Error("owned file wake cancelled"));
        return f.runtime.get(f.attemptID);
      },
    },
    () => false,
  );
  try {
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${f.attemptID}`;
    const already = AbortSignal.abort(new Error("owned file wake cancelled"));
    await expect(demand(f.workspaceID, f.owner, true, undefined, already)).rejects.toThrow(
      "owned file wake cancelled",
    );
    expect(resumes).toBe(0);
    await expect(
      demand(f.workspaceID, f.owner, true, f.attemptID, cancelled.signal),
    ).rejects.toThrow("owned file wake cancelled");
    // Once native resume was deliberately admitted its outcome stays observable;
    // cancelling the file request must not replay it or publish the file write.
    expect(resumes).toBe(1);
    expect(f.starts()).toBe(0);
    expect(
      await f.database.client`SELECT id FROM factory.operation WHERE kind='workspace.command'`,
    ).toHaveLength(0);
  } finally {
    await f.dispose();
  }
}, 30000);

test("PTY input has its own immutable request identity and never replays keystrokes", async () => {
  const f = await commandFixture();
  const id = crypto.randomUUID();
  try {
    const opened = await f.commands.start(
      f.owner,
      { requestID: id, workspaceID: f.workspaceID, command: "interactive-terminal", env: {} },
      "terminal",
    );
    expect(opened.kind).toBe("terminal");
    const input = {
      requestID: crypto.randomUUID(),
      terminalID: id,
      action: "input" as const,
      input: "private-terminal-input\n",
    };
    await f.commands.terminalOperation(f.owner, input);
    await f.commands.terminalOperation(f.owner, input);
    expect(f.terminalInputs()).toBe(1);
    await expect(
      f.commands.terminalOperation(f.owner, { ...input, input: "changed\n" }),
    ).rejects.toThrow("different input");
    const [retained] = await f.database.client<
      { value: string }[]
    >`SELECT row_to_json(operation)::text AS value FROM factory.operation operation WHERE id=${input.requestID} AND kind='workspace.terminal_op'`;
    expect(retained?.value).not.toContain("private-terminal-input");
    expect(
      (await f.commands.read(f.owner, { commandID: id, stdout: 0, stderr: 0 }, "terminal")).kind,
    ).toBe("terminal");
    expect((await f.commands.cancel(f.owner, id, "terminal")).state).toBe("cancelled");
    expect(f.starts()).toBe(1);
  } finally {
    await f.dispose();
  }
}, 30000);

test("unconfirmed dispatch stays uncertain after a same-input retry", async () => {
  const f = await commandFixture(true);
  const input = {
    requestID: crypto.randomUUID(),
    workspaceID: f.workspaceID,
    command: "printf do-not-replay",
    env: {},
  };
  try {
    expect((await f.commands.start(f.owner, input)).state).toBe("uncertain");
    expect((await f.commands.start(f.owner, input)).state).toBe("uncertain");
    expect(f.starts()).toBe(1);
    const [row] = await f.database.client<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM factory.operation WHERE kind='workspace.command'`;
    expect(row?.count).toBe(1);
  } finally {
    await f.dispose();
  }
}, 30000);

test("kicking a collaborator blocks further commands but does not cancel their admitted work", async () => {
  const f = await commandFixture();
  const id = crypto.randomUUID();
  try {
    await f.sharing.decide(f.owner, {
      commandID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      userID: f.guest,
      permission: "collaborate",
      expectedVersion: 0,
    });
    await f.commands.start(f.guest, {
      requestID: id,
      workspaceID: f.workspaceID,
      command: "printf shared-work",
      env: {},
    });
    await f.sharing.decide(f.owner, {
      commandID: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      userID: f.guest,
      permission: null,
      expectedVersion: 1,
    });
    await expect(f.commands.status(f.guest, id)).rejects.toThrow("Workspace not found");
    await expect(
      f.commands.start(f.guest, {
        requestID: crypto.randomUUID(),
        workspaceID: f.workspaceID,
        command: "must-not-run",
        env: {},
      }),
    ).rejects.toThrow("Workspace not found");
    expect(f.starts()).toBe(1);
    expect(f.native.get(id)?.state).toBe("running");
    expect((await f.commands.list(f.owner, f.workspaceID)).commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ commandID: id, actorID: f.guest, state: "running" }),
      ]),
    );
    expect((await f.commands.status(f.owner, id)).state).toBe("running");
    const snapshot = f.native.get(id);
    if (!snapshot) throw new Error("Native fixture command missing");
    snapshot.state = "exited";
    snapshot.exitCode = 7;
    f.hub.message(
      f.child,
      JSON.stringify({ type: "command-state", commandCount: 0, data: JSON.stringify(snapshot) }),
    );
    await eventually(
      () => f.commands.status(f.owner, id),
      (state) => state.state === "exited",
      "Accepted command outcome was not retained",
    );
    expect((await f.commands.status(f.owner, id)).exitCode).toBe(7);
  } finally {
    await f.dispose();
  }
}, 30000);
