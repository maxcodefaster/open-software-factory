import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("invalid native installation fails before database bootstrap or optional network work", async () => {
  let connections = 0;
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        connections++;
        socket.end();
      },
      data(socket) {
        socket.end();
      },
    },
  });
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `let network=0;globalThis.fetch=async()=>{network++;throw Error("Unexpected network");};
const {createFactoryApplication}=await import(${JSON.stringify(resolve(import.meta.dir, "application.ts"))});
try {await createFactoryApplication();process.exitCode=1;}
catch(error){console.log(JSON.stringify({message:error.message,network}));}`,
    ],
    {
      env: {
        PATH: process.env["PATH"],
        NODE_ENV: "test",
        DATABASE_URL: `postgres://owned:owned@127.0.0.1:${listener.port}/owned`,
        FACTORY_AUTH_SECRET: "owned-test-signing-secret-not-a-real-credential",
        FACTORY_FORGEJO_API_URL: "https://forge.example.invalid",
        FACTORY_FORGEJO_OWNER: "owned",
        FACTORY_FORGEJO_TOKEN: "owned",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({
      message: "Factory requires its Substrate installation configuration",
      network: 0,
    });
    expect(connections).toBe(0);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    listener.stop(true);
  }
});
