import { expect, test } from "bun:test";
import { createRepositoryMirrorController } from "../../apps/factory/src/repository-mirrors/controller";
import { ForgeMirrorWriteError } from "../../packages/forge/src/mirrors";
import type { RepositoryMirror } from "../../packages/project-domain/src/repository-mirror";
import { factoryProcess } from "../fixtures/factory-process";

test("repository mirrors retain secret-free command intent, admin authority, exact retries and observed native recovery", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  const actor = crypto.randomUUID(),
    outsider = crypto.randomUUID(),
    projectID = crypto.randomUUID();
  const mirrors: RepositoryMirror[] = [];
  let creates = 0,
    syncs = 0,
    deletes = 0;
  let loseCreateResponse = true,
    failSync = false,
    loseWithoutEffect = false;
  const targetURL = "https://github.com/team/backup.git";
  const input = {
    commandID: crypto.randomUUID(),
    targetURL,
    username: "git-user",
    token: "private-owned-mirror-token",
    confirmOverwrite: true as const,
  };
  const controller = createRepositoryMirrorController({
    database,
    apiURL: "https://forge.factory.test/api/v1/",
    publicURL: "https://forge.factory.test",
    owner: "factory",
    signingKey: "owned-mirror-fingerprint",
    allowedOrigins: ["https://github.com"],
    forge: {
      pushMirrors: {
        async list() {
          return mirrors.map((value) => ({ ...value }));
        },
        async create(_repo, value) {
          const [intent] =
            await database.client`SELECT id FROM factory.repository_mirror_command WHERE id=${input.commandID}`;
          expect(intent).toBeDefined();
          expect(value.token).toBe(input.token);
          creates++;
          if (loseWithoutEffect) throw new ForgeMirrorWriteError(true);
          const mirror = {
            remoteName: "remote_mirror_owned",
            targetURL,
            syncOnCommit: true,
            interval: "1h0m0s",
            branchFilter: "",
            lastAttempt: null,
            failed: false,
          };
          mirrors.push(mirror);
          if (loseCreateResponse) {
            loseCreateResponse = false;
            throw new ForgeMirrorWriteError(true);
          }
          return mirror;
        },
        async sync() {
          syncs++;
          for (const mirror of mirrors) {
            mirror.lastAttempt = new Date(Date.now() + syncs * 1000).toISOString();
            mirror.failed = failSync;
          }
          if (failSync) throw new ForgeMirrorWriteError(true);
        },
        async remove(_repo, name) {
          deletes++;
          const index = mirrors.findIndex((value) => value.remoteName === name);
          if (index >= 0) mirrors.splice(index, 1);
        },
      },
    },
  });
  try {
    for (const id of [actor, outsider])
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${id},'Owned mirror user',${`${id}@mirror.invalid`},true)`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${actor})`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by,desktop_background_key)
      VALUES(${projectID},'owned-mirror','Owned mirror Project','https://forge.factory.test/factory/source','main','.devcontainer/devcontainer.json',${actor},'river-landscape')`;
    await expect(controller.get(outsider, projectID)).rejects.toThrow("System Manager");
    await expect(controller.create(outsider, projectID, input)).rejects.toThrow("System Manager");
    expect(creates).toBe(0);
    await expect(
      controller.create(actor, projectID, {
        ...input,
        targetURL: "https://user:token@github.com/team/copy.git",
      }),
    ).rejects.toThrow("HTTPS");
    await expect(
      controller.create(actor, projectID, { ...input, targetURL: "https://metadata.invalid/repo" }),
    ).rejects.toThrow("HTTPS");
    await expect(controller.create(actor, projectID, input)).rejects.toThrow("unconfirmed");
    expect((await controller.get(actor, projectID)).pending).toBeNull();
    expect((await controller.create(actor, projectID, input)).mirrors).toHaveLength(1);
    expect(creates).toBe(1);
    await expect(
      controller.create(actor, projectID, { ...input, token: "changed" }),
    ).rejects.toThrow("different input");
    await expect(
      controller.create(actor, projectID, { ...input, commandID: crypto.randomUUID() }),
    ).rejects.toThrow("already has");
    const syncID = crypto.randomUUID();
    await controller.sync(actor, projectID, syncID);
    await controller.sync(actor, projectID, syncID);
    expect(syncs).toBe(1);
    failSync = true;
    await expect(controller.sync(actor, projectID, crypto.randomUUID())).rejects.toThrow(
      "unconfirmed",
    );
    const failed = await controller.get(actor, projectID);
    expect(failed.pending).toBeNull();
    expect(failed.mirrors[0]?.failed).toBe(true);
    await expect(
      controller.remove(actor, projectID, {
        commandID: crypto.randomUUID(),
        remoteName: "remote_mirror_owned",
        targetURL: "https://github.com/wrong/repo",
      }),
    ).rejects.toThrow("identity changed");
    const remove = { commandID: crypto.randomUUID(), remoteName: "remote_mirror_owned", targetURL };
    expect((await controller.remove(actor, projectID, remove)).mirrors).toHaveLength(0);
    await controller.remove(actor, projectID, remove);
    expect(deletes).toBe(1);
    loseWithoutEffect = true;
    const unconfirmed = { ...input, commandID: crypto.randomUUID() };
    await expect(controller.create(actor, projectID, unconfirmed)).rejects.toThrow("unconfirmed");
    const pending = await controller.get(actor, projectID);
    expect(pending.pending?.commandID).toBe(unconfirmed.commandID);
    expect((await controller.create(actor, projectID, unconfirmed)).pending).toEqual(
      pending.pending,
    );
    expect(creates).toBe(2);
    await expect(
      controller.create(actor, projectID, { ...input, commandID: crypto.randomUUID() }),
    ).rejects.toThrow("unconfirmed");
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${outsider})`;
    await expect(controller.create(outsider, projectID, unconfirmed)).rejects.toThrow(
      "different input",
    );
    expect(
      (await controller.acknowledge(actor, projectID, unconfirmed.commandID)).pending,
    ).toBeNull();
    expect(creates).toBe(2);
    await expect(controller.create(actor, projectID, unconfirmed)).rejects.toThrow(
      "new explicit command",
    );
    loseWithoutEffect = false;
    const concurrent = await Promise.allSettled([
      controller.create(actor, projectID, { ...input, commandID: crypto.randomUUID() }),
      controller.create(actor, projectID, { ...input, commandID: crypto.randomUUID() }),
    ]);
    expect(concurrent.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(creates).toBe(3);
    expect((await controller.get(actor, projectID)).mirrors).toHaveLength(1);
    const rows =
      await database.client`SELECT row_to_json(command) FROM factory.repository_mirror_command command`;
    expect(JSON.stringify(rows)).not.toContain(input.token);
    expect(JSON.stringify(rows)).not.toContain(input.username);
    await expect(
      (async () => {
        await database.client`UPDATE factory.repository_mirror_command SET target_url='changed' WHERE id=${input.commandID}`;
      })(),
    ).rejects.toThrow("immutable");
  } finally {
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 60_000);
