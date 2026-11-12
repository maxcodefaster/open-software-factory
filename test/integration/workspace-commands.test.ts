import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createWorkspaceCommands } from "../../apps/factory/src/workspace/commands";
import { createWorkspaceSharing } from "../../apps/factory/src/workspace/sharing";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { personalWorkspaceIdentity } from "../../packages/workspace-domain/src/workspace";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { installOwnedRuntimeConfiguration } from "../fixtures/runtime-configuration";

async function commandFixture(loseStartReply = false) {
  const restore = installOwnedRuntimeConfiguration();
  const process = await factoryProcess();
  const database = process.connect();
  const owner = crypto.randomUUID(),
    guest = crypto.randomUUID(),
    project = crypto.randomUUID();
  const workspaceID = personalWorkspaceIdentity(project, owner).workspaceID;
  const attemptID = crypto.randomUUID();
  for (const id of [owner, guest])
    await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Command fixture',${`${id}@factory.invalid`})`;
  await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
    VALUES(${project},${`command-${project}`},'Command fixture','https://github.com/example/project','main','.devcontainer/devcontainer.json',${owner})`;
  for (const id of [owner, guest])
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${project},${id},'developer',${owner})`;
  await database.client`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
    VALUES(${workspaceID},${project},'personal',${owner},'main',${"a".repeat(40)},${owner})`;
  await database.client`INSERT INTO factory.runtime_attempt(id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
    VALUES(${attemptID},${project},${workspaceID},1,${"a".repeat(40)},'ready','parent-command-fixture','child-command-fixture',now(),${owner})`;
  const hub = new RuntimeHub(async () => {});
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
  const runtime = createRuntimeController(database, hub, "command-fixture-key", {
    async prepareExecution() {
      throw new Error("No new execution is allowed");
    },
  });
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
      await database.client.end({ timeout: 2 });
      await process.dispose();
      restore();
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
    >`SELECT row_to_json(command)::text AS record FROM factory.workspace_command command WHERE id=${requestID}`;
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

test("command output demand resumes the exact paused compute without replaying the command", async () => {
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
      .client`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${f.attemptID}`;
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
    >`SELECT row_to_json(operation)::text AS value FROM factory.workspace_terminal_operation operation WHERE id=${input.requestID}`;
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
    >`SELECT count(*)::int AS count FROM factory.workspace_command`;
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
