import { expect, test } from "bun:test";
import type { SubstrateBrowserRelay } from "#runtime-kubernetes/substrate-browser-client";
import { SubstrateRPCError } from "#runtime-kubernetes/substrate-control";
import { claimAgentWriterIn } from "../../apps/factory/src/access/change-writer";
import { createChangeWriterController } from "../../apps/factory/src/access/writer-controller";
import { createBuildBrowserController } from "../../apps/factory/src/agent/browser-controller";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createSubstrateBrowsers } from "../../apps/factory/src/runtime/browser-api";
import { substrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import { computeAllocationIn } from "../../apps/factory/src/usage/allocation";
import { substrateFixture } from "../fixtures/substrate";

async function ownedBrowser() {
  const f = await substrateFixture("a".repeat(40), "ticket");
  const calls: { method: string; input: any }[] = [];
  let parent: any, template: any, actor: any, relay: SubstrateBrowserRelay | undefined;
  const tweaks: {
    before?: (method: string, input: any) => Promise<void>;
    after?: (method: string, value: any) => Promise<void>;
  } = {};
  const clock = async () => {
    const [row] = await f.database.client<{ at: string }[]>`SELECT clock_timestamp()::text AS at`;
    return new Date(row!.at).toISOString();
  };
  const rpc = async (method: string, input: any): Promise<unknown> => {
    await tweaks.before?.(method, input);
    calls.push({ method, input: structuredClone(input) });
    const browser =
      (
        input.actor?.name ??
        input.actorTemplate?.name ??
        input.actorTemplate?.metadata?.name ??
        ""
      ).startsWith("browser-") || input.actor?.metadata?.name?.startsWith("browser-");
    let value: any;
    if (method === "GetAtespace") value = f.space;
    else if (method === "GetActorTemplate") {
      value = browser ? template : f.template;
      if (!value) throw new SubstrateRPCError("NotFound", "absent");
    } else if (method === "GetActorEgressPolicy") {
      value = {
        metadata: {
          name: "default",
          atespace: f.atespace,
          uid: crypto.randomUUID(),
          version: "1",
          createTime: await clock(),
        },
        rules: [{ tlsPassthrough: { hostnames: ["factory.test"], ports: { numbers: [443] } } }],
      };
    } else if (method === "GetActor") {
      value = browser ? actor : parent;
      if (!value) throw new SubstrateRPCError("NotFound", "absent");
    } else if (method === "CreateActorTemplate") {
      template = {
        ...input.actorTemplate,
        metadata: {
          ...input.actorTemplate.metadata,
          uid: crypto.randomUUID(),
          version: "1",
          createTime: await clock(),
        },
      };
      value = template;
    } else if (method === "CreateActor") {
      if (!browser) parent = await f.createdActor();
      else
        actor = {
          ...input.actor,
          metadata: {
            ...input.actor.metadata,
            uid: crypto.randomUUID(),
            version: "1",
            createTime: await clock(),
          },
          status: { state: "ACTOR_STATE_SUSPENDED" },
        };
      value = browser ? actor : parent;
    } else if (method === "ResumeActor") {
      // The pinned official ResumeActorRequest has only its Actor ref. Unlike
      // DeleteActor, it has no UID/version options; permissive peers hid this.
      if (browser)
        expect(input).toEqual({ actor: { atespace: f.atespace, name: actor.metadata.name } });
      value = browser ? actor : parent;
      value.metadata.version = "2";
      value.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      value = { actor: value };
    } else if (method === "DeleteActor") {
      if (
        !actor ||
        input.options.uid !== actor.metadata.uid ||
        input.options.version !== actor.metadata.version
      )
        throw new Error("Wrong native Browser Actor delete preconditions");
      actor = undefined;
      value = {};
    } else if (method === "DeleteActorTemplate") {
      if (
        !template ||
        input.options.uid !== template.metadata.uid ||
        input.options.version !== template.metadata.version
      )
        throw new Error("Wrong native Browser template delete preconditions");
      template = undefined;
      value = {};
    } else throw new Error(`Unexpected native operation ${method}`);
    await tweaks.after?.(method, value);
    return structuredClone(value);
  };
  try {
    await f.controller(rpc);
    const [provision] = await f.database.client<{ configuration: Record<string, unknown> }[]>`
      SELECT intent->'configuration' AS configuration FROM factory.substrate_provision WHERE owner_id=${f.workspaceID} AND kind='workspace'`;
    const { projectID: _project, ...configuration } = provision!.configuration;
    const installation = substrateInstallationConfiguration(configuration);
    const store = createAgentTurnStore(f.database);
    const [approval] = await f.database.client<{ revision: string }[]>`
      SELECT approval.requirement_revision_id AS revision FROM factory.change change
      JOIN factory.requirement_approval approval ON approval.id=change.requirement_approval_id WHERE change.id=${f.changeID}`;
    const { turn } = await store.admit(
      {
        kind: "change-start",
        commandId: crypto.randomUUID(),
        projectId: f.projectID,
        ticketId: f.ticketID,
        changeId: f.changeID,
        createdBy: f.userID,
        conversationId: null,
      },
      {
        mode: "build",
        modelId: "owned-browser-model",
        skillRevisionIds: [],
        requiredSkillRevisionIds: [],
        conversationVersion: null,
        requirementRevisionId: approval!.revision,
      },
      (sql, record) => claimAgentWriterIn(sql, f.changeID, record.id, f.userID),
    );
    const agentSessionID = `ses_owned_${turn.id.replaceAll("-", "")}`;
    await f.database.client`INSERT INTO factory.change_agent_turn_intent(
      turn_id,change_id,session_id,prompt_id,prompt_text,bootstrap,session_title,runtime_attempt_id)
      VALUES(${turn.id},${f.changeID},${agentSessionID},${`msg_${turn.id.replaceAll("-", "")}`},
        'Inspect native App',true,'Owned browser',NULL)`;
    const claimed = await store.claimPending(turn.id);
    if (!claimed?.ownerToken) throw new Error("Owned browser turn lease missing");
    const writers = createChangeWriterController({
      database: f.database,
      runtime: { stop: async () => {}, get: async () => ({ state: "stopped" }) },
      fenceSource: async () => {},
      protect: async () => {},
      stopAgent: async () => {},
      agentUsername: "owned-browser",
    });
    expect(await writers.prepareAgent(f.changeID, turn.id, claimed.ownerToken)).toBe(true);
    await f.execution(rpc).start(f.userID);
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='ready',ready_at=now() WHERE id=${f.attemptID}`;
    await f.database.client`UPDATE factory.change_agent_turn_intent
      SET runtime_attempt_id=${f.attemptID} WHERE turn_id=${turn.id}`;
    await f.database.client`INSERT INTO factory.change_agent_session(
      change_id,runtime_attempt_id,opencode_session_id,state,created_by,active_turn_id,native_session_confirmed_at)
      VALUES(${f.changeID},${f.attemptID},${agentSessionID},'starting',${f.userID},${turn.id},now())`;
    expect(await store.beginDispatch(turn.id, claimed.ownerToken)).not.toBeNull();
    f.hub.hasAppChannel = (_attempt, name) => name === "app";
    f.hub.parentOperation = async (_attempt, operation, beforeSend) => {
      await beforeSend?.(() => {});
      expect(operation.action).toBe("browser-inspection");
      const request = JSON.parse(String(operation["data"]));
      return {
        data: JSON.stringify({
          sessionId: request.sessionId,
          turnId: turn.id,
          runtimeAttemptId: f.attemptID,
          generation: 1,
          app: request.call.arguments.app,
          headCommit: "a".repeat(40),
          workingTreeModified: false,
          observedAt: new Date().toISOString(),
        }),
      };
    };
    const emitted: string[] = [];
    const makeNative = () =>
      createSubstrateBrowsers(f.database, f.hub, "owned-browser-secret", installation, {
        call: rpc,
        browser: {
          image: `registry.test/browser@sha256:${"b".repeat(64)}`,
          routerURL: "wss://atenet-router.ate-system.svc",
          caFile: "/unused/ca",
          credentialFile: "/unused/client",
        },
        async connect(_config, callbacks, signal, beforeConnect) {
          expect(_config).not.toHaveProperty("image");
          await beforeConnect?.(() => {
            signal?.throwIfAborted();
            emitted.push("connect");
          });
          relay = callbacks;
          return {
            async operation(operation, beforeSend) {
              await beforeSend(() => {
                emitted.push(operation.action);
              });
              if (operation.action === "browser-renew") return {};
              const context = await callbacks.inspect("app", new AbortController().signal);
              return {
                data: JSON.stringify({
                  content: [{ type: "text", text: "Native App inspected" }],
                  structuredContent: context,
                }),
              };
            },
            close() {
              emitted.push("disconnect");
            },
          };
        },
      });
    const native = makeNative();
    const controller = createBuildBrowserController(f.database, "owned-browser-secret", native);
    const grant = await controller.prepare(turn.id, claimed.ownerToken);
    const auth = await controller.authorize(grant.sessionID, `Bearer ${grant.bearer}`);
    if (!auth) throw new Error("Owned Browser authorization unavailable");
    calls.length = 0;
    return {
      ...f,
      controller,
      native,
      makeNative,
      grant,
      scope: auth.session,
      ownerToken: claimed.ownerToken,
      turn,
      calls,
      tweaks,
      emitted,
      relay: () => relay!,
      actor: () => actor,
      template: () => template,
      async open() {
        return controller.call(
          auth.session,
          claimed.ownerToken!,
          {
            name: "browser_open",
            arguments: { app: "app" },
          },
          crypto.randomUUID(),
        );
      },
      async dispose() {
        await controller.closeTurn(turn.id);
        await f.dispose();
      },
    };
  } catch (cause) {
    await f.dispose();
    throw cause;
  }
}

test("native Browser product owner freezes intent, provisions once, observes Source and independently deletes original UIDs", async () => {
  const f = await ownedBrowser();
  try {
    expect(f.calls).toEqual([]);
    const before = await computeAllocationIn(f.database.client, f.projectID);
    const observed = await f.open();
    expect(observed.structuredContent?.headCommit).toBe("a".repeat(40));
    expect(
      f.calls.filter((call) => call.method.startsWith("Create")).map((call) => call.method),
    ).toEqual(["CreateActorTemplate", "CreateActor"]);
    const [binding] = await f.database.client<{ actor_uid: string; template_uid: string }[]>`
      SELECT result->>'actorUid' AS actor_uid,payload->>'templateUid' AS template_uid,payload->>'connectAttemptedAt' AS connect_attempted_at
      FROM factory.operation WHERE id=${f.grant.sessionID} AND kind='runtime.browser'`;
    if (!binding) throw new Error("Native Browser binding was not retained");
    expect(binding.actor_uid).toBe(f.actor().metadata.uid);
    expect(binding.template_uid).toBe(f.template().metadata.uid);
    const allocated = await computeAllocationIn(f.database.client, f.projectID);
    expect(allocated.sandboxes).toBe(before.sandboxes + 1);
    expect(allocated.cpuMilli).toBe(before.cpuMilli + 1000);
    await f.controller.closeTurn(f.turn.id);
    expect(f.actor()).toBeUndefined();
    expect(f.template()).toBeUndefined();
    expect(
      f.calls.filter((call) => call.method.startsWith("Delete")).map((call) => call.method),
    ).toEqual(["DeleteActor", "DeleteActorTemplate"]);
    expect(await computeAllocationIn(f.database.client, f.projectID)).toEqual(before);
    const [closed] = await f.database.client<
      { state: string }[]
    >`SELECT state FROM factory.build_browser_session WHERE id=${f.grant.sessionID}`;
    if (!closed) throw new Error("Native Browser Session was not retained");
    expect(closed.state).toBe("closed");
  } finally {
    await f.dispose();
  }
});

test("lost native Browser Create acknowledgement is recovered by original identity, never replayed", async () => {
  const f = await ownedBrowser();
  try {
    f.tweaks.after = async (method) => {
      if (method === "CreateActor") throw new Error("Owned acknowledgement lost");
    };
    await expect(f.open()).rejects.toMatchObject({ code: "conflict" });
    expect(f.calls.filter((call) => call.method === "CreateActor")).toHaveLength(1);
    expect(f.emitted).not.toContain("connect");
    const [row] = await f.database.client<
      {
        actor_uid: string | null;
        actor_deleted_at: string | null;
        template_deleted_at: string | null;
      }[]
    >`SELECT result->>'actorUid' AS actor_uid,payload->>'actorDeletedAt' AS actor_deleted_at,payload->>'templateDeletedAt' AS template_deleted_at
      FROM factory.operation WHERE id=${f.grant.sessionID} AND kind='runtime.browser'`;
    if (!row) throw new Error("Unknown native Browser outcome was not retained");
    expect(row.actor_uid).toBeTruthy();
    expect(row.actor_deleted_at).toBeTruthy();
    expect(row.template_deleted_at).toBeTruthy();
  } finally {
    await f.dispose();
  }
});

test("native Browser App callbacks recheck live authority after Stop and preserve only their declared channel", async () => {
  const f = await ownedBrowser();
  try {
    await f.open();
    let appCalls = 0;
    f.hub.requestBrowserApp = async (_attempt, app, request, path, beforeSend) => {
      await beforeSend(() => {
        appCalls++;
      });
      expect(app).toBe("app");
      expect(path).toBe("/api/state");
      expect(request.headers.get("authorization")).toBe("Bearer App-only");
      return new Response("owned App");
    };
    const request = () =>
      new Request("http://browser.internal/api/state", {
        headers: { authorization: "Bearer App-only" },
      });
    expect(await (await f.relay().requestApp("app", request(), "/api/state")).text()).toBe(
      "owned App",
    );
    await expect(f.relay().requestApp("foreign", request(), "/api/state")).rejects.toThrow(
      "not declared",
    );
    await createChangeAgentStop(f.database, f.hub).persist(f.changeID);
    await expect(f.relay().requestApp("app", request(), "/api/state")).rejects.toThrow();
    expect(appCalls).toBe(1);
  } finally {
    await f.dispose();
  }
});

test("Factory restart cannot reconnect to or recreate a previously dispatched Browser", async () => {
  const f = await ownedBrowser();
  try {
    await f.open();
    const old = f.calls.length;
    await expect(
      f
        .makeNative()
        .prepare(f.scope, async (send) => send(new Date(Date.now() + 20_000).toISOString())),
    ).rejects.toThrow("never reconnect");
    expect(f.calls).toHaveLength(old);
  } finally {
    await f.dispose();
  }
});

test("native Browser WebSocket pins the original App/Actor and rechecks SQL authority on each send", async () => {
  const f = await ownedBrowser();
  try {
    await f.open();
    const [parent] = await f.database.client<{ actor_uid: string }[]>`
      SELECT actor_uid FROM factory.runtime_attempt WHERE id=${f.attemptID}`;
    let opens = 0,
      sends = 0;
    f.hub.openBrowserAppSocket = async (attempt, app, request, path, identity, authorize) => {
      expect(attempt).toBe(f.attemptID);
      expect(app).toBe("app");
      expect(path).toBe("/hmr?owned=1");
      expect(request.headers.get("cookie")).toBe("app_session=owned");
      expect(identity).toEqual({
        actorUID: parent!.actor_uid,
        generation: 1,
        target: "http://127.0.0.1:4300",
      });
      await authorize(() => {
        opens++;
      });
      return {
        protocol: "owned-hmr",
        messages: new ReadableStream(),
        async send() {
          await authorize(() => {
            sends++;
          });
        },
        close() {},
      };
    };
    const request = () =>
      new Request("http://browser.internal/hmr?owned=1", {
        headers: { cookie: "app_session=owned", "sec-websocket-protocol": "owned-hmr" },
      });
    await expect(f.relay().openAppSocket("source", request(), "/hmr?owned=1")).rejects.toThrow(
      "not declared",
    );
    const socket = await f.relay().openAppSocket("app", request(), "/hmr?owned=1");
    await socket.send(1, Buffer.from("original"));
    await createChangeAgentStop(f.database, f.hub).persist(f.changeID);
    await expect(socket.send(2, Buffer.from([0, 255]))).rejects.toThrow();
    await expect(f.relay().openAppSocket("app", request(), "/hmr?owned=1")).rejects.toThrow();
    expect(opens).toBe(1);
    expect(sends).toBe(1);
  } finally {
    await f.dispose();
  }
});

test("native Browser WebSocket cancellation while waiting for authority never sends to the App", async () => {
  const f = await ownedBrowser();
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const abort = new AbortController();
  try {
    await f.open();
    let dispatched = 0;
    f.hub.openBrowserAppSocket = async (_attempt, _app, _request, _path, _identity, authorize) => {
      entered.resolve();
      await resume.promise;
      await authorize(() => {
        dispatched++;
      });
      throw new Error("cancelled opening should not return a socket");
    };
    const opening = f
      .relay()
      .openAppSocket(
        "app",
        new Request("http://browser.internal/hmr", { signal: abort.signal }),
        "/hmr",
      );
    void opening.catch(() => {});
    await entered.promise;
    abort.abort();
    resume.resolve();
    await expect(opening).rejects.toThrow();
    expect(dispatched).toBe(0);
  } finally {
    resume.resolve();
    await f.dispose();
  }
});

test("unknown native Browser Create remains closing until its original UID can be observed", async () => {
  const f = await ownedBrowser();
  let invisible = true;
  try {
    f.tweaks.after = async (method) => {
      if (method === "CreateActor") throw new Error("Owned Create acknowledgement unavailable");
    };
    f.tweaks.before = async (method, input) => {
      if (invisible && method === "GetActor" && input.actor?.name.startsWith("browser-"))
        throw new SubstrateRPCError("NotFound", "temporarily unconfirmed");
    };
    await expect(f.open()).rejects.toMatchObject({ code: "conflict" });
    const [pending] = await f.database.client`
      SELECT session.state,native.result->>'actorUid' AS actor_uid,native.payload->>'actorDeletedAt' AS actor_deleted_at
      FROM factory.build_browser_session session
      JOIN factory.operation native ON native.id=session.id AND native.kind='runtime.browser'
      WHERE session.id=${f.grant.sessionID}`;
    expect(pending).toEqual({ state: "closing", actor_uid: null, actor_deleted_at: null });
    await f.controller.reconcileCleanup();
    const [stillPending] = await f.database.client`
      SELECT session.state,native.result->>'actorUid' AS actor_uid,native.payload->>'actorDeletedAt' AS actor_deleted_at
      FROM factory.build_browser_session session
      JOIN factory.operation native ON native.id=session.id AND native.kind='runtime.browser'
      WHERE session.id=${f.grant.sessionID}`;
    expect(stillPending).toEqual({ state: "closing", actor_uid: null, actor_deleted_at: null });
    expect(f.calls.filter((call) => call.method === "CreateActor")).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === "DeleteActor")).toHaveLength(0);
    invisible = false;
    await f.controller.reconcileCleanup();
    const [closed] = await f.database.client<
      { state: string }[]
    >`SELECT state FROM factory.build_browser_session WHERE id=${f.grant.sessionID}`;
    if (!closed) throw new Error("Native Browser Session was not retained");
    expect(closed.state).toBe("closed");
    expect(f.calls.filter((call) => call.method === "CreateActor")).toHaveLength(1);
  } finally {
    invisible = false;
    await f.dispose();
  }
});

test("native Browser cleanup refuses a replaced Actor UID even when the Parent is stopped", async () => {
  const f = await ownedBrowser();
  let uid = "";
  try {
    await f.open();
    uid = f.actor().metadata.uid;
    f.actor().metadata.uid = crypto.randomUUID();
    await f.database.client`UPDATE factory.runtime_attempt SET state='stopped'
      WHERE id=${f.attemptID}`;
    await f.controller.closeTurn(f.turn.id);
    const [pending] = await f.database.client`SELECT state,cleanup_confirmed_at
      FROM factory.build_browser_session WHERE id=${f.grant.sessionID}`;
    expect(pending).toEqual({ state: "closing", cleanup_confirmed_at: null });
    expect(f.calls.filter((call) => call.method === "DeleteActor")).toHaveLength(0);
    f.actor().metadata.uid = uid;
    await f.controller.reconcileCleanup();
    expect(f.calls.filter((call) => call.method === "DeleteActor")).toHaveLength(1);
  } finally {
    if (f.actor() && uid) f.actor().metadata.uid = uid; // Restore only the controlled API peer.
    await f.dispose();
  }
});

test("Stop during an admitted native template Create prevents Actor dispatch and still cleans that template", async () => {
  const f = await ownedBrowser();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  try {
    f.tweaks.before = async (method) => {
      if (method === "CreateActorTemplate") {
        entered.resolve();
        await release.promise;
      }
    };
    const opening = f.open();
    void opening.catch(() => {});
    await entered.promise;
    await createChangeAgentStop(f.database, f.hub).persist(f.changeID);
    release.resolve();
    await expect(opening).rejects.toMatchObject({ code: "conflict" });
    expect(f.calls.filter((call) => call.method === "CreateActorTemplate")).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === "CreateActor")).toHaveLength(0);
    expect(f.calls.filter((call) => call.method === "DeleteActorTemplate")).toHaveLength(1);
    expect(f.emitted).not.toContain("connect");
  } finally {
    release.resolve();
    await f.dispose();
  }
});
