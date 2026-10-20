import { afterAll, beforeAll, expect, test } from "bun:test";
import { pinnedOpenCode, observe } from "../fixtures/pinned-opencode";
import { ensureOpenCodeMessageBoundary } from "../../apps/factory/src/agent/opencode-client";
import { buildModelID, fixture as changeFixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import { createUsageJournal, type UsageEntry } from "../../apps/factory/src/usage/journal";
import { drainOpenCodeUsage, openCodeUsageEntry } from "../../apps/factory/src/usage/opencode";
import { defaultExecutionPolicy } from "../../packages/conversation-domain/src/execution-policy";
import { createRecordedOpenCodeUsage } from "../../apps/factory/src/usage/record-opencode";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import upstream from "../../upstream.json";

// Kubernetes is injected in the cleanup case; these artifacts are never
// launched, and no fixture may inherit the retained installation's forge token.
const runtimeConfiguration = {
  FACTORY_RUNTIME_HOST_IMAGE: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
  FACTORY_BUILD_RUNTIME_HOST_IMAGE: `example.invalid/owned-build@sha256:${"b".repeat(64)}`,
  FACTORY_VERIFICATION_RUNTIME_HOST_IMAGE: `example.invalid/owned-verification@sha256:${"c".repeat(64)}`,
  FACTORY_BROWSER_TOOLS_IMAGE: `example.invalid/owned-browser@sha256:${"d".repeat(64)}`,
  FACTORY_FORGEJO_API_URL: "http://127.0.0.1:1/api/v1",
  FACTORY_FORGEJO_TOKEN: "owned-mocked-forge-token",
  FACTORY_FORGEJO_OWNER: "owned-runtime-fixture",
};
const previousRuntimeConfiguration = new Map<string, string | undefined>();
beforeAll(() => {
  for (const [key, value] of Object.entries(runtimeConfiguration)) {
    previousRuntimeConfiguration.set(key, process.env[key]);
    process.env[key] = value;
  }
});
afterAll(() => {
  for (const [key, value] of previousRuntimeConfiguration) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("pinned native OpenCode durable log exposes fresh per-step consumption and replay", async () => {
  const fixture = await pinnedOpenCode(
    undefined,
    undefined,
    process.env["FACTORY_OPENCODE_SERVER_TEST_BINARY"],
  );
  const owned = await factoryProcess();
  const database = owned.connect();
  const journal = createUsageJournal(database);
  try {
    await fixture.control("/usage", "POST");
    const id = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
    const promptID = `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`;
    await fixture.client.session.create({
      id,
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
    });
    await ensureOpenCodeMessageBoundary(fixture.client, id);
    const operationID = `owned:${crypto.randomUUID()}`;
    await journal.begin({
      id: operationID,
      projectID: null,
      userID: null,
      purpose: "coding",
      engine: "opencode",
      provider: "openai",
      model: buildModelID,
      rate: {
        provider: "openai",
        model: buildModelID,
        source: "contract",
        fetchedAt: new Date().toISOString(),
        tiers: [{ above: 0, input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 }],
      },
    });
    await fixture.client.session.prompt({
      sessionID: id,
      id: promptID,
      text: "Return only a short answer",
      delivery: "queue",
      resume: true,
    });
    await observe(
      () => fixture.control(),
      (value) => value.heldRequests > 0,
    );
    await fixture.control("/release", "POST");
    await observe(
      () => fixture.client.message.list({ sessionID: id, limit: 100 }),
      (value) =>
        value.data.some(
          (message) => message.type === "assistant" && message.time.completed !== undefined,
        ),
    );
    const events = [];
    for await (const event of fixture.client.session.log(
      { sessionID: id, after: 0, follow: false },
      { signal: AbortSignal.timeout(5000) },
    )) {
      if (event.type === "log.synced") break;
      if (event.type === "session.step.ended" || event.type === "session.usage.recorded")
        events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);
    const step = events.find((event) => event.type === "session.step.ended");
    expect(step?.data.tokens.cache.read).toBe(30);
    const drain = async (after: number) =>
      drainOpenCodeUsage({
        sessionID: id,
        after,
        log: (cursor) =>
          fixture.client.session.log(
            { sessionID: id, after: cursor, follow: false },
            { signal: AbortSignal.timeout(5000) },
          ),
        record: (entry, sequence) =>
          journal.record(operationID, entry, { sessionID: id, sequence }),
        advance: (sequence) => journal.advance(operationID, id, sequence),
      });
    await drain(0);
    const read = () => database.client<
      Array<{ event_id: string; counters: unknown; nano_usd: string }>
    >`
      SELECT event_id, counters, nano_usd FROM factory.usage_entry
      WHERE operation_id=${operationID} ORDER BY event_id`;
    const before = await observe(read, (entries) => entries.length === events.length);
    expect(before).toHaveLength(events.length);
    expect(before.every((entry) => entry.nano_usd === "125000")).toBe(true);
    expect(before[0]?.counters).toMatchObject({
      input: 70,
      output: 20,
      cacheRead: 30,
      reasoning: 5,
    });
    // Interrupted observer restarts from zero; the same native event must not charge twice.
    await drain(0);
    await fixture.control("/kill", "POST");
    await fixture.control("/restart", "POST");
    await observe(
      async () => {
        try {
          return (await fixture.client.server.info()).version;
        } catch {
          return undefined;
        }
      },
      (version) => version === upstream.openCode.version,
      "Owned native restart did not become ready",
      45_000,
    );
    await drain(0);
    await drain(await journal.cursor(operationID, id));
    expect(await read()).toEqual(before);
    expect((await fixture.control()).providerRequests).toBe(events.length);
    // Fresh operations share one native Session but inherit only its watermark.
    const secondID = `owned:${crypto.randomUUID()}`;
    const baseline = await journal.cursor(operationID, id);
    await journal.begin(
      {
        id: secondID,
        projectID: null,
        userID: null,
        purpose: "coding",
        engine: "opencode",
        provider: "openai",
        model: buildModelID,
        rate: {
          provider: "openai",
          model: buildModelID,
          source: "contract",
          fetchedAt: new Date().toISOString(),
          tiers: [{ above: 0, input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 }],
        },
      },
      [{ sessionID: id, sequence: baseline }],
    );
    const calls = (await fixture.control()).providerRequests;
    await fixture.client.session.prompt({
      sessionID: id,
      id: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
      text: "One more short answer. No tools.",
      delivery: "queue",
      resume: true,
    });
    await observe(
      () => fixture.control(),
      (v) => v.providerRequests > calls,
    );
    await observe(
      () => fixture.client.session.active(),
      (v) => !Object.hasOwn(v, id),
    );
    const secondDrain = () =>
      drainOpenCodeUsage({
        sessionID: id,
        after: baseline,
        log: (after) =>
          fixture.client.session.log(
            { sessionID: id, after, follow: false },
            { signal: AbortSignal.timeout(5000) },
          ),
        record: (entry, sequence) => journal.record(secondID, entry, { sessionID: id, sequence }),
        advance: (sequence) => journal.advance(secondID, id, sequence),
      });
    await secondDrain();
    await secondDrain();
    expect(await read()).toEqual(before);
    const second =
      await database.client`SELECT event_id FROM factory.usage_entry WHERE operation_id=${secondID}`;
    expect(second.length).toBe((await fixture.control()).providerRequests - calls);
    const fork = await fixture.client.session.fork({
      sessionID: id,
    });
    let inherited = 0;
    await drainOpenCodeUsage({
      sessionID: fork.id,
      after: 0,
      log: (after) =>
        fixture.client.session.log(
          { sessionID: fork.id, after, follow: false },
          { signal: AbortSignal.timeout(5000) },
        ),
      record: async () => {
        inherited++;
      },
      advance: async () => {},
    });
    expect(inherited).toBe(0);
    const beforeCompaction = (await fixture.control()).providerRequests;
    await fixture.client.session.compact({ sessionID: id });
    await observe(
      () => fixture.control(),
      (v) => v.providerRequests > beforeCompaction,
    );
    await observe(
      () => fixture.client.session.active(),
      (v) => !Object.hasOwn(v, id),
    );
    await secondDrain();
    expect(
      (
        await database.client`SELECT source FROM factory.usage_entry WHERE operation_id=${secondID}`
      ).some((row) => row["source"] === "compaction"),
    ).toBe(true);
    await fixture.control("/child", "POST");
    const beforeChild = (await fixture.control()).providerRequests;
    await fixture.client.session.prompt({
      sessionID: id,
      id: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
      text: "Run the requested child",
      delivery: "queue",
      resume: true,
    });
    const child = await observe(
      () => fixture.client.session.list({ parentID: id, limit: 100 }),
      (page) => page.data.length > 0,
    );
    const childSession = child.data[0];
    if (!childSession) throw new Error("Owned native child missing");
    const childID = childSession.id;
    await observe(
      () => fixture.client.session.get({ sessionID: childID }),
      (info) => info.outcome === "succeeded",
    );
    await observe(
      () => fixture.client.session.active(),
      (active) => !Object.hasOwn(active, id),
    );
    const childDrain = () =>
      drainOpenCodeUsage({
        sessionID: childID,
        after: 0,
        log: (after) =>
          fixture.client.session.log(
            { sessionID: childID, after, follow: false },
            { signal: AbortSignal.timeout(5000) },
          ),
        record: (entry, sequence) =>
          journal.record(secondID, entry, { sessionID: childID, sequence }),
        advance: (sequence) => journal.advance(secondID, childID, sequence),
      });
    const observed = await observe(
      async () => {
        await secondDrain();
        await childDrain();
        const entries = [
          ...(await database.client<
            { event_id: string; input: number }[]
          >`SELECT event_id,(counters->>'input')::int AS input FROM factory.usage_entry WHERE operation_id=${secondID} ORDER BY event_id`),
        ];
        return { entries, requests: (await fixture.control()).providerRequests };
      },
      // Native compaction aggregates its retry counters into one consumption event.
      (value) =>
        value.entries.reduce((total, entry) => total + entry.input, 0) ===
        (value.requests - calls) * 70,
      "Native child consumption did not reconcile with actual provider calls",
    );
    const combined = observed.entries;
    expect(combined.reduce((total, entry) => total + entry.input, 0)).toBe(
      (observed.requests - calls) * 70,
    );
    expect((await fixture.control()).providerRequests - beforeChild).toBeGreaterThanOrEqual(3);
    await childDrain();
    expect([
      ...(await database.client`SELECT event_id,(counters->>'input')::int AS input FROM factory.usage_entry WHERE operation_id=${secondID} ORDER BY event_id`),
    ]).toEqual(combined);
  } finally {
    await fixture.dispose();
    await database.client.end();
    await owned.dispose();
  }
}, 120_000);

test("native failed steps distinguish local allowance denial from unknown provider usage", async () => {
  const fixture = await pinnedOpenCode();
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  try {
    for (const failure of ["deny", "fail"] as const) {
      await fixture.control(`/${failure}`, "POST");
      const id = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
      await fixture.client.session.create({
        id,
        title: "Owned failure proof",
        location: { directory: "/workspace/project" },
        model: { providerID: "factory", id: buildModelID },
      });
      await ensureOpenCodeMessageBoundary(fixture.client, id);
      await fixture.client.session.prompt({
        sessionID: id,
        id: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
        text: "One short answer",
        delivery: "queue",
        resume: true,
      });
      await observe(
        () => fixture.client.session.get({ sessionID: id }),
        (s) => s.outcome === "failed",
      );
      const failed = [];
      for await (const event of fixture.client.session.log(
        { sessionID: id, after: 0, follow: false },
        { signal: AbortSignal.timeout(5000) },
      )) {
        if (event.type === "log.synced") break;
        if (event.type === "session.step.failed") failed.push(event);
      }
      expect(failed).toHaveLength(1);
      const failureEvent = failed[0];
      if (!failureEvent) throw new Error("Owned native failed step missing");
      const entry = openCodeUsageEntry(failureEvent, id);
      if (failure === "deny") expect(entry).toBeNull();
      else
        expect(entry).toMatchObject({ outcome: "failed", counters: { input: null, output: null } });
    }
    await fixture.control("/clear", "POST");
    await fixture.control("/hold", "POST");
    const id = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
    await fixture.client.session.create({
      id,
      title: "Owned interrupted proof",
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
    });
    await ensureOpenCodeMessageBoundary(fixture.client, id);
    await fixture.client.session.prompt({
      sessionID: id,
      id: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
      text: "One short answer",
      delivery: "queue",
      resume: true,
    });
    await observe(
      () => fixture.control(),
      (s) => s.heldRequests > 0,
    );
    await fixture.client.session.interrupt({ sessionID: id });
    await observe(
      () => fixture.client.session.get({ sessionID: id }),
      (s) => s.outcome === "interrupted",
    );
    const entries: UsageEntry[] = [];
    await drainOpenCodeUsage({
      sessionID: id,
      after: 0,
      log: (after) =>
        fixture.client.session.log(
          { sessionID: id, after, follow: false },
          { signal: AbortSignal.timeout(5000) },
        ),
      record: async (entry) => {
        entries.push(entry);
      },
      advance: async () => {},
    });
    expect(
      entries.every((entry) => Object.values(entry.counters).every((value) => value === null)),
    ).toBe(true);
    const turnID = crypto.randomUUID();
    const journal = createUsageJournal(database);
    await journal.begin({
      id: `turn:${turnID}`,
      projectID: null,
      userID: null,
      purpose: "coding",
      engine: "opencode",
      provider: "openai",
      model: buildModelID,
      rate: null,
    });
    for (const entry of entries) await journal.record(`turn:${turnID}`, entry);
    await createRecordedOpenCodeUsage(database).settle(turnID, "interrupted");
    const read = async () => [
      ...(await database.client`
      SELECT source,counters FROM factory.usage_entry WHERE operation_id=${`turn:${turnID}`} ORDER BY event_id`),
    ];
    const interrupted = await read();
    expect(interrupted.length).toBeGreaterThan(0);
    expect(interrupted.some((entry) => entry["source"] === "unobserved")).toBe(true);
    expect(interrupted.every((entry) => entry["counters"].input === null)).toBe(true);
    await createRecordedOpenCodeUsage(database).settle(turnID, "interrupted");
    expect(await read()).toEqual(interrupted);
  } finally {
    await database.client.end({ timeout: 2 });
    await processFixture.dispose();
    await fixture.dispose();
  }
}, 120_000);

test("native paused Coding resumes only explicitly and journals one retained Session without replay", async () => {
  const native = await pinnedOpenCode();
  const processFixture = await factoryProcess();
  const database = processFixture.connect();
  let controller: ReturnType<Awaited<ReturnType<typeof changeFixture>>["controller"]> | undefined;
  try {
    const owned = await changeFixture(undefined, undefined, database);
    // This owned usage fixture has no native package installer. Initialize its
    // own empty guidance just like the default Change fixture; package loading
    // is proved separately by the native Skill cases.
    const empty = JSON.stringify({ required: [], optional: [], selected: [] });
    await database.client`INSERT INTO factory.system_skill_settings(singleton,version,planning,build,updated_by)
      VALUES(true,1,${empty}::jsonb,${empty}::jsonb,${owned.userID})
      ON CONFLICT(singleton) DO UPDATE SET version=factory.system_skill_settings.version+1,
        planning=EXCLUDED.planning,build=EXCLUDED.build,updated_by=EXCLUDED.updated_by`;
    owned.hub.request = (_attempt, _channel, request, path) =>
      native.transport(request, path ?? new URL(request.url).pathname);
    await native.control("/usage", "POST");
    await native.control("/tool", "POST");
    await native.client.session.create({
      id: owned.sessionID,
      title: "Owned paused Coding",
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
    });
    await ensureOpenCodeMessageBoundary(native.client, owned.sessionID);
    controller = owned.controller();
    const commandID = crypto.randomUUID();
    await controller.prompt(
      owned.changeID,
      "Run the controlled tool and answer",
      owned.userID,
      commandID,
    );
    await observe(
      async () => {
        if (!controller) throw new Error("Owned Coding controller unavailable");
        const view = await controller.get(owned.changeID, undefined, false);
        if (view.turn && ["failed", "uncertain", "stopped"].includes(view.turn.state))
          throw new Error(
            view.turn.summary ?? view.lastError ?? "Owned Coding failed before inference",
          );
        return native.control("/release-aux", "POST");
      },
      (value) => value.heldCodingRequests === 1,
    );
    const turn = await owned.turn(commandID);
    if (!turn) throw new Error("Owned native turn missing");
    await database.client`INSERT INTO factory.execution_policy(scope,version,policy,timezone,updated_by)
      VALUES('factory',1,${JSON.stringify({ ...defaultExecutionPolicy(), codingUSD: 0 })}::jsonb,'UTC',${owned.userID})`;
    await database.client`INSERT INTO factory.coding_pause(turn_id,reason) VALUES(${turn.id},'finish-reserve-used')`;
    await native.control("/deny", "POST");
    await native.control("/release", "POST");
    await observe(
      () => owned.turn(commandID),
      (value) => value?.state === "failed",
    );
    expect((await controller.get(owned.changeID)).codingPause?.turnID).toBe(turn.id);
    const read = async () => [
      ...(await database.client`SELECT event_id,source,counters FROM factory.usage_entry WHERE operation_id=${`turn:${turn.id}`} ORDER BY event_id`),
    ];
    await observe(
      async () =>
        database.client`SELECT settled_at FROM factory.usage_operation WHERE id=${`turn:${turn.id}`}`,
      (operations) => Boolean(operations[0]?.["settled_at"]),
      "Controller did not finish settling its native step",
    );
    const before = await read();
    expect(before.length).toBeGreaterThan(0);
    expect(before.some((entry) => entry["source"] === "step")).toBe(true);
    expect(before.find((entry) => entry["source"] === "step")?.["counters"]).toMatchObject({
      input: 70,
      output: 20,
    });
    const calls = (await native.control()).providerRequests;
    await expect(
      controller.resume(owned.changeID, owned.userID, crypto.randomUUID(), turn.id),
    ).rejects.toMatchObject({ code: "conflict" });
    await database.client`UPDATE factory.execution_policy SET policy=${JSON.stringify(defaultExecutionPolicy())}::jsonb WHERE scope='factory'`;
    await native.control("/clear", "POST");
    await native.control("/hold", "POST");
    expect((await native.control()).providerRequests).toBe(calls);
    const resumeID = crypto.randomUUID();
    await Promise.all([
      controller.resume(owned.changeID, owned.userID, resumeID, turn.id),
      controller.resume(owned.changeID, owned.userID, resumeID, turn.id),
    ]);
    await observe(
      () => native.control(),
      (value) => value.heldRequests === 1,
    );
    expect((await native.control()).providerRequests).toBe(calls + 1);
    await native.control("/release", "POST");
    await observe(
      () => owned.turn(resumeID),
      (value) => value?.state === "completed",
    );
    expect(await read()).toEqual(before);
    expect(
      await database.client`SELECT id FROM factory.agent_turn WHERE change_id=${owned.changeID}`,
    ).toHaveLength(2);
    const resumed = await owned.turn(resumeID);
    const resumedEntries = await observe(
      async () =>
        database.client`SELECT event_id FROM factory.usage_entry WHERE operation_id=${`turn:${resumed?.id}`}`,
      (entries) => entries.length > 0,
      "Resumed native usage did not settle",
    );
    expect(resumedEntries).toHaveLength(1);
    expect((await controller.get(owned.changeID)).codingPause).toBeNull();
    // Native auxiliary consumption can arrive after the turn's terminal outcome.
    const afterResume = (await native.control()).providerRequests;
    await native.client.session.compact({ sessionID: owned.sessionID });
    await observe(
      () => native.control(),
      (value) => value.providerRequests > afterResume,
    );
    await observe(
      async () => {
        const entries: UsageEntry[] = [];
        await drainOpenCodeUsage({
          sessionID: owned.sessionID,
          after: 0,
          log: (after) =>
            native.client.session.log(
              { sessionID: owned.sessionID, after, follow: false },
              { signal: AbortSignal.timeout(5000) },
            ),
          record: async (entry) => {
            entries.push(entry);
          },
          advance: async () => {},
        });
        return entries;
      },
      (entries) => entries.some((entry) => entry.source === "compaction"),
    );
    const nativeCalls = (await native.control()).providerRequests;
    const consumption = async () => [
      ...(await database.client`SELECT entry.event_id,entry.source,entry.counters FROM factory.usage_entry entry
        JOIN factory.usage_operation operation ON operation.id=entry.operation_id
        WHERE operation.project_id=${owned.projectID} ORDER BY entry.event_id`),
    ];
    let deletes = 0;
    let entriesAtDeletion: Awaited<ReturnType<typeof consumption>> = [];
    await database.client`UPDATE factory.runtime_attempt SET kubernetes_uid='owned-native-pod'
      WHERE id=${owned.attemptID}`;
    const runtime = createRuntimeController(
      database,
      owned.hub,
      "owned-native-cleanup",
      {
        prepareExecution: async () => {
          throw new Error("Cleanup must not prepare source");
        },
      },
      {
        ...createKubernetesClient(),
        getNamespace: async () => ({ uid: "owned-native-namespace", labels: {} }),
        getPod: async () => ({
          uid: "owned-native-pod",
          phase: "Running",
          labels: {},
          envboxImage: upstream.envbox.image,
          runtimeHostImage: process.env["FACTORY_RUNTIME_HOST_IMAGE"] ?? "owned",
        }),
        deletePod: async () => {
          entriesAtDeletion = await consumption();
          deletes++;
        },
        deleteNamespace: async () => {
          throw new Error("Source must survive cleanup");
        },
      },
      async () => "",
    );
    await runtime.stop(owned.attemptID);
    await observe(
      async () => (await runtime.get(owned.attemptID))?.state,
      (state) => state === "stopped",
      "Native consumption did not drain before owned compute cleanup",
    );
    expect(deletes).toBe(1);
    expect(entriesAtDeletion.some((entry) => entry["source"] === "compaction")).toBe(true);
    // One exact local 403 denied inference before reaching a paid provider.
    expect(entriesAtDeletion.reduce((sum, entry) => sum + entry["counters"].input, 0)).toBe(
      (nativeCalls - 1) * 70,
    );
    const drained = await consumption();
    await createRecordedOpenCodeUsage(database).drainAttempt(owned.attemptID, native.client);
    expect(await consumption()).toEqual(drained);
    expect(await read()).toEqual(before);

    // Lost storage must expose incomplete coverage even for a previously settled turn.
    const recorded = createRecordedOpenCodeUsage(database);
    await recorded.markUnavailable(owned.attemptID);
    const unavailable = await consumption();
    expect(unavailable.filter((entry) => entry["source"] === "unobserved")).toHaveLength(2);
    expect(unavailable.filter((entry) => entry["source"] !== "unobserved")).toEqual(drained);
    await recorded.markUnavailable(owned.attemptID);
    expect(await consumption()).toEqual(unavailable);
  } finally {
    await controller?.shutdown();
    await database.client.end();
    await processFixture.dispose();
    await native.dispose();
  }
}, 120_000);
