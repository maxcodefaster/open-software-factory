import { expect, test } from "bun:test";
import { nativeRuntimeFixture } from "../fixtures/native-runtime";

test.each(["personal", "ticket", "staging"] as const)(
  "native %s retains every declared App before its original Actor Create",
  async (kind) => {
    const f = await nativeRuntimeFixture(kind === "ticket" ? "ticket" : "personal");
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let starting: Promise<unknown> | undefined;
    try {
      f.beforeCall(async (method) => {
        if (method === "CreateActor") {
          entered.resolve();
          await release.promise;
        }
      });
      const runtime = f.controller();
      starting =
        kind === "personal"
          ? runtime.start(f.projectID, f.userID)
          : kind === "ticket"
            ? runtime.startPersisted(f.changeID, f.userID)
            : runtime.ensureStaging(f.projectID, f.userID);
      void starting.catch(entered.reject);
      await entered.promise;
      const [saved] = await f.database.client<
        { id: string; state: string; revision: string; apps: string[]; attempted: boolean }[]
      >`
        SELECT attempt.id,attempt.state,attempt.revision,attempt.declared_apps AS apps,
          attempt.create_attempted_at IS NOT NULL AS attempted
        FROM factory.runtime_attempt attempt WHERE attempt.project_id=${f.projectID} AND attempt.atespace IS NOT NULL`;
      expect(saved).toMatchObject({
        state: "create-intended",
        revision: f.revision,
        apps: ["app", "app-editor", "app-api"],
        attempted: true,
      });
      expect(f.calls.filter((call) => call.method === "ResumeActor")).toHaveLength(0);
      release.resolve();
      await starting;
      expect((await runtime.get(saved?.id ?? ""))?.revision).toBe(f.revision);
      expect(f.calls.filter((call) => call.method === "CreateActor")).toHaveLength(1);
    } finally {
      release.resolve();
      await starting?.catch(() => {});
      await f.dispose();
    }
  },
  60_000,
);

test("native Staging refuses missing App declaration before retaining a Preview or making external creates", async () => {
  const f = await nativeRuntimeFixture("personal", false);
  try {
    await expect(f.controller().ensureStaging(f.projectID, f.userID)).rejects.toThrow(
      ".factory/system.json",
    );
    expect(
      await f.database
        .client`SELECT scope_id AS project_id FROM factory.operation WHERE kind='delivery.staging_preview' AND scope_type='project' AND scope_id=${f.projectID}`,
    ).toHaveLength(0);
    expect(f.calls.filter((call) => call.method.startsWith("Create"))).toHaveLength(0);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("native terminal bootstrap failure supersedes an earlier uncertain observation and is not revived by reconnect", async () => {
  const f = await nativeRuntimeFixture();
  try {
    const runtime = f.controller(),
      attempt = await runtime.start(f.projectID, f.userID);
    if (!attempt) throw Error("Owned native Runtime missing");
    await f.database
      .client`UPDATE factory.runtime_attempt SET failure='Owned lost observation' WHERE id=${attempt.id}`;
    const cause = "Dev Container build failed: actual native bootstrap cause";
    await runtime.status(attempt.id, "failed", cause);
    expect(await runtime.get(attempt.id)).toMatchObject({ state: "failed", failure: cause });
    const dispatched = f.calls.filter((call) =>
      ["CreateActor", "ResumeActor"].includes(call.method),
    ).length;
    await runtime.status(attempt.id, "reconnecting", "Still observing original Actor");
    expect(await runtime.get(attempt.id)).toMatchObject({ state: "failed", failure: cause });
    expect(
      f.calls.filter((call) => ["CreateActor", "ResumeActor"].includes(call.method)),
    ).toHaveLength(dispatched);
  } finally {
    await f.dispose();
  }
}, 60_000);
