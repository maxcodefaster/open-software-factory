import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("the built desktop keeps Settings code split and stays within the measured client budgets", async () => {
  const build = process.env["FACTORY_BUILD_DIRECTORY"];
  if (!build) throw new Error("Client budgets require the owned integration build");
  const assets = resolve(build, "client/assets");
  const files = await readdir(assets);
  const sizes: Record<string, number> = {};
  for (const [name, maximum] of [
    ["settings-workspace", 40_000],
    ["factory", 400_000],
  ] as const) {
    const matches = files.filter((file) => file.startsWith(`${name}-`) && file.endsWith(".js"));
    expect(matches, `Missing unique ${name} client entry`).toHaveLength(1);
    const file = matches[0];
    if (!file) throw new Error("Client entry missing");
    const bytes = (await readFile(resolve(assets, file))).byteLength;
    sizes[name] = bytes;
    expect(bytes, `${name} must not eagerly import every feature`).toBeLessThanOrEqual(maximum);
  }
  await Bun.write(".factory/test-results/client-budgets.json", JSON.stringify(sizes, null, 2));
});
