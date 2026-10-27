import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { starterFiles } from "../../apps/factory/src/setup/starter";
import { ownedPostgresServer, ownedTestDatabase } from "./postgres-server";

// A fresh authored checkout, build output and database for every proof.
// No retained Factory process, repository, user or runtime is touched.
export async function starterApplication() {
  const id = crypto.randomUUID();
  const directory = resolve(".factory/test-results/starters", id);
  const identity = process.env["FACTORY_TEST_POSTGRES"];
  const server = identity ? undefined : await ownedPostgresServer();
  const postgres = identity ? JSON.parse(identity) : server?.identity;
  let database: Awaited<ReturnType<typeof ownedTestDatabase>> | undefined;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const logs: Promise<void>[] = [];
  async function dispose() {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    await Promise.all(logs);
    await database?.dispose();
    await server?.dispose();
  }
  try {
    if (!postgres) throw new Error("Owned Starter PostgreSQL identity is missing");
    database = await ownedTestDatabase(postgres, id, false, "template0");
    const env = {
      ...process.env,
      DATABASE_URL: database.url,
      BETTER_AUTH_SECRET: `owned-starter-${id}`,
      NODE_ENV: "development",
    };
    for (const file of await starterFiles()) {
      const path = resolve(directory, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
    }
    await symlink(
      resolve("templates/starter-app/node_modules"),
      resolve(directory, "node_modules"),
    );
    return {
      directory,
      env,
      async command(args: string[]) {
        const child = Bun.spawn(args, {
          cwd: directory,
          env: { ...env, NODE_ENV: "production" },
          stdout: "pipe",
          stderr: "pipe",
        });
        children.push(child);
        const [stdout, stderr, status] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (status !== 0) throw new Error(`Starter ${args.join(" ")} failed: ${stdout}\n${stderr}`);
        return stdout;
      },
      spawn(args: string[], extra: Record<string, string>) {
        const child = Bun.spawn(args, {
          cwd: directory,
          env: { ...env, ...extra },
          stdout: "pipe",
          stderr: "pipe",
        });
        children.push(child);
        for (const [name, stream] of [
          ["stdout", child.stdout],
          ["stderr", child.stderr],
        ] as const)
          logs.push(
            new Response(stream)
              .text()
              .then((body) =>
                writeFile(resolve(directory, `server-${children.length}-${name}.log`), body),
              ),
          );
        return child;
      },
      async sessionPath() {
        return (
          await this.command([
            "node",
            "--input-type=module",
            "-e",
            'const { sessionFunctionPath } = await import("./test/session.ts"); console.log(await sessionFunctionPath());',
          ])
        ).trim();
      },
      dispose,
    };
  } catch (cause) {
    await dispose();
    throw cause;
  }
}
