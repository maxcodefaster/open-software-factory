import { expect, test } from "bun:test";
import {
  beginInstallationMaintenance,
  finishInstallationMaintenance,
  installationInMaintenance,
} from "../../apps/factory/src/installation/maintenance";
import { eventually, factoryProcess } from "../fixtures/factory-process";

test("upgrade admission serializes against real inference intent and never discards pending work", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const userID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const generationID = crypto.randomUUID();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writing: Promise<unknown> | undefined;
  try {
    await database.client`
      INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES(${userID},'Owned maintenance fixture',${`maintenance-${userID}@factory.local`},true)`;
    await database.client`
      INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${`maintenance-${projectID}`},'Owned maintenance fixture',
        'https://example.invalid/maintenance','main','.devcontainer/devcontainer.json',${userID})`;
    writing = database.client.begin(async (sql) => {
      await sql`
        INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,created_by)
        VALUES(${generationID},${projectID},${"a".repeat(40)},${userID})`;
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const maintenance = beginInstallationMaintenance(database).then(
      () => ({ allowed: true, message: "" }),
      (cause: Error) => ({ allowed: false, message: cause.message }),
    );
    await eventually(
      async () => {
        const [waiting] = await database.client<{ waiting: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
              AND query LIKE '%UPDATE factory.installation_maintenance SET enabled=true%') AS waiting`;
        return waiting?.waiting;
      },
      Boolean,
      "Maintenance did not wait for the actual concurrent admission transaction",
    );
    release.resolve();
    await writing;
    const result = await maintenance;
    expect(result.allowed).toBe(false);
    expect(result.message).toContain("Finish or explicitly stop");
    expect(await installationInMaintenance(database)).toBe(false);
    const [retained] = await database.client<{ state: string }[]>`
      SELECT state FROM factory.knowledge_generation WHERE id=${generationID}`;
    expect(retained?.state).toBe("pending");

    await database.client`
      UPDATE factory.knowledge_generation SET state='failed',completed_at=now()
      WHERE id=${generationID}`;
    await beginInstallationMaintenance(database);
    expect(await installationInMaintenance(database)).toBe(true);
    const admitWhilePaused = async () => {
      await database.client`
        INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,created_by)
        VALUES(${crypto.randomUUID()},${projectID},${"a".repeat(40)},${userID})`;
    };
    await expect(admitWhilePaused()).rejects.toThrow("maintenance");
    await finishInstallationMaintenance(database);
    expect(await installationInMaintenance(database)).toBe(false);
    await database.client`
      INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,created_by)
      VALUES(${crypto.randomUUID()},${projectID},${"a".repeat(40)},${userID})`;
  } finally {
    release.resolve();
    await writing?.catch(() => {});
    await database.client.end();
    await host.dispose();
  }
}, 60_000);
