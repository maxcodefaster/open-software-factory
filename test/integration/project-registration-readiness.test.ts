import { expect, test } from "bun:test";
import { createProjectService } from "../../apps/factory/src/projects/service";
import { requireSetupReady } from "../../apps/factory/src/setup/execution-gate";
import { eventually, factoryProcess } from "../fixtures/factory-process";

test("local repository registration persists configuration intent before preparing a Project", async () => {
  const factory = await factoryProcess();
  const database = factory.connect();
  const manager = crypto.randomUUID();
  const calls: string[] = [];
  const recoveringCalls: boolean[] = [];
  try {
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${manager},'Local repository owner',${`${manager}@factory.test`})`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${manager})`;
    const dependencies = {
      database,
      localRepositoryOrigin: "https://forge.test",
      forgeOwner: "factory",
      readDefaultBranch: async () => "main",
      onRegistered: async (projectID: string, userID: string, recovering: boolean) => {
        expect(userID).toBe(manager);
        const [configuration] = await database.client<{ state: string }[]>`
          SELECT state FROM factory.operation
          WHERE kind='projects.setup_readiness' AND idempotency_key=${`projects.setup_readiness:${projectID}:configuration`}`;
        expect(configuration?.state).toBe("pending");
        await expect(requireSetupReady(database.client, projectID)).rejects.toThrow("Confirm");
        calls.push("inspect-configuration");
        recoveringCalls.push(recovering);
      },
    };
    const service = createProjectService(dependencies);
    const slug = `local-acme-${crypto.randomUUID()}`;
    const project = await service.register(manager, {
      name: "Local ACME",
      slug,
      repositoryUrl: `https://forge.test/factory/${slug}.git`,
      defaultBranch: "main",
      actorTemplatePath: ".factory/actor-template.json",
    });
    await eventually(
      async () => calls.length,
      (count) => count === 1,
      "Registration did not prepare setup",
    );
    expect(calls).toEqual(["inspect-configuration"]);
    expect(recoveringCalls).toEqual([false]);
    await expect(requireSetupReady(database.client, project.id)).rejects.toThrow("Confirm");
    expect(
      await database.client`SELECT id FROM factory.runtime_attempt WHERE project_id=${project.id}`,
    ).toHaveLength(0);
    await service.recover();
    expect(recoveringCalls).toEqual([false, true]);
    await database.client`UPDATE factory.operation SET state='ready',completed_at=now()
      WHERE kind='projects.setup_readiness' AND idempotency_key=${`projects.setup_readiness:${project.id}:configuration`}`;
    await requireSetupReady(database.client, project.id);
    await service.recover();
    expect(recoveringCalls).toEqual([false, true]);
  } finally {
    await database.client.end({ timeout: 2 });
    await factory.dispose();
  }
}, 60_000);
