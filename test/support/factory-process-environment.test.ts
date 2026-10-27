import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { factoryProcessCommand } from "../fixtures/factory-process";

test("owned Factory children cannot load the developer's model or credential environment file", async () => {
  const directory = resolve(".factory/test-results/process-environment", crypto.randomUUID());
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, ".env"), "FACTORY_OWNED_ENV_PROBE=must-not-be-loaded\n");
  const env = { ...process.env };
  delete env["FACTORY_OWNED_ENV_PROBE"];
  try {
    const child = Bun.spawn(
      factoryProcessCommand("-e", [
        'process.stdout.write(process.env["FACTORY_OWNED_ENV_PROBE"] ?? "isolated")',
      ]),
      { cwd: directory, env, stdout: "pipe", stderr: "pipe" },
    );
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(output).toBe("isolated");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
