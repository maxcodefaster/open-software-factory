import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localOpenBao } from "../../scripts/factory/openbao";
import { createOpenBaoEnvironmentSecrets } from "../../apps/factory/src/environments/openbao";
import { createOpenBaoKV } from "../../apps/factory/src/secrets/openbao";
import { z } from "zod";

test("pinned OpenBao encrypts persistent values, limits Factory credentials and survives a sealed restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-owned-openbao-"));
  const service = await localOpenBao(directory);
  const commandID = crypto.randomUUID();
  const key = `projects/${crypto.randomUUID()}/development/${commandID}`;
  const value = {
    commandID,
    fingerprint: "a".repeat(64),
    bundle: {
      variables: [
        {
          name: "API_KEY",
          value: "owned-encrypted-secret-sentinel",
          runtime: true,
          build: false,
          verification: false,
        },
      ],
      registries: [],
    },
  };
  async function docker(...args: string[]) {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "ignore" });
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) throw new Error("Owned OpenBao test command failed");
    return output;
  }
  try {
    const configuration = await service.start();
    const adapter = createOpenBaoEnvironmentSecrets({
      address: configuration.FACTORY_OPENBAO_URL,
      tokenFile: configuration.FACTORY_OPENBAO_TOKEN_FILE,
      caFile: configuration.FACTORY_OPENBAO_CA_FILE,
    });
    expect(await adapter.read(key)).toBeUndefined();
    await adapter.create(key, value);
    expect(await adapter.read(key)).toEqual(value);
    await expect(adapter.create(key, value)).rejects.toThrow("unavailable");
    const token = (await readFile(configuration.FACTORY_OPENBAO_TOKEN_FILE, "utf8")).trim();
    const administrative = await fetch(`${configuration.FACTORY_OPENBAO_URL}/v1/sys/mounts`, {
      tls: { ca: await readFile(configuration.FACTORY_OPENBAO_CA_FILE, "utf8") },
      headers: { "X-Vault-Token": token },
    });
    expect(administrative.status).toBe(403);
    const deletion = await fetch(`${configuration.FACTORY_OPENBAO_URL}/v1/factory/data/${key}`, {
      tls: { ca: await readFile(configuration.FACTORY_OPENBAO_CA_FILE, "utf8") },
      method: "DELETE",
      headers: { "X-Vault-Token": token },
    });
    expect(deletion.status).toBe(403);
    expect(
      JSON.parse(await readFile(join(service.directory, "bootstrap.json"), "utf8")).root_token,
    ).toBe("");
    expect(
      (
        await docker(
          "exec",
          service.container,
          "sh",
          "-c",
          "grep -R -l owned-encrypted-secret-sentinel /bao/data || true",
        )
      ).trim(),
    ).toBe("");
    await docker("restart", service.container);
    await service.start();
    expect(await adapter.read(key)).toEqual(value);
    // Refresh only the Factory ACL after root revocation, without replacing encrypted data.
    await service.start(true);
    expect(await adapter.read(key)).toEqual(value);
    const kv = createOpenBaoKV({
      address: configuration.FACTORY_OPENBAO_URL,
      tokenFile: configuration.FACTORY_OPENBAO_TOKEN_FILE,
      caFile: configuration.FACTORY_OPENBAO_CA_FILE,
    });
    const modelKey = `models/${crypto.randomUUID()}/${crypto.randomUUID()}`;
    const importKey = `imports/${crypto.randomUUID()}/${crypto.randomUUID()}`;
    const secret = z.object({ value: z.string() });
    await kv.create(modelKey, { value: "owned-model-sentinel" }, secret);
    expect(await kv.read(modelKey, secret)).toEqual({ value: "owned-model-sentinel" });
    await kv.create(importKey, { value: "owned-import-sentinel" }, secret);
    await kv.removeImport(importKey);
    expect(await kv.read(importKey, secret)).toBeUndefined();
    await expect(kv.removeImport(modelKey)).rejects.toThrow("Only temporary");
    const unauthenticatedRoot = await fetch(
      `${configuration.FACTORY_OPENBAO_URL}/v1/sys/generate-root/attempt`,
      { tls: { ca: await readFile(configuration.FACTORY_OPENBAO_CA_FILE, "utf8") } },
    );
    expect(unauthenticatedRoot.ok).toBe(false);
    expect(
      JSON.parse(await readFile(join(service.directory, "bootstrap.json"), "utf8")).root_token,
    ).toBe("");
    // The local scoped AppRole renews credentials after a long stopped session.
    await writeFile(configuration.FACTORY_OPENBAO_TOKEN_FILE, "expired-owned-token", {
      mode: 0o600,
    });
    await service.start();
    expect(await adapter.read(key)).toEqual(value);
  } finally {
    await service.dispose();
    await rm(directory, { recursive: true });
  }
}, 60_000);
