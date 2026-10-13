import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgeBrowserLogoutPage } from "../../packages/forge/src/browser-logout";

export async function installForgeBrowserLogout(options: {
  factoryURL: string;
  execute: (args: string[]) => Promise<unknown>;
  copy: (source: string, destination: string) => Promise<unknown>;
}) {
  const directory = await mkdtemp(join(tmpdir(), "factory-forge-logout-"));
  try {
    const page = join(directory, "factory-sign-out.html");
    await writeFile(page, forgeBrowserLogoutPage(options.factoryURL), { mode: 0o644 });
    const assets = "/var/lib/gitea/custom/public/assets";
    await options.execute(["mkdir", "-p", assets]);
    await options.copy(page, `${assets}/factory-sign-out.html`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
