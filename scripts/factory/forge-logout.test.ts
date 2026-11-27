import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { run } from "../owned-client-process";

test("Forge browser logout stays readable after a restrictive installer umask", async () => {
  const result = await run([
    process.execPath,
    "--no-env-file",
    "-e",
    `
      import { stat, lstat } from "node:fs/promises";
      const { installForgeBrowserLogout } = await import(process.argv[1]);
      process.umask(0o077);
      let copied;
      const commands = [];
      await installForgeBrowserLogout({
        factoryURL: "https://factory.invalid",
        execute: async (args) => { commands.push(args); },
        copy: async (source, destination) => {
          copied = { source, destination, mode: (await stat(source)).mode & 0o777 };
        },
      });
      let removed = false;
      try { await lstat(copied.source); }
      catch (cause) { if (cause.code === "ENOENT") removed = true; else throw cause; }
      console.log(JSON.stringify({ mode: copied.mode, destination: copied.destination,
        umask: process.umask(), removed, commands }));
    `,
    resolve(import.meta.dir, "forge-logout.ts"),
  ]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    mode: 0o644,
    destination: "/var/lib/gitea/custom/public/assets/factory-sign-out.html",
    umask: 0o077,
    removed: true,
    commands: [["mkdir", "-p", "/var/lib/gitea/custom/public/assets"]],
  });
});
