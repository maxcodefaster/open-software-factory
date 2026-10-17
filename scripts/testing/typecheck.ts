import { resolve } from "node:path";
import { prepareTestPrerequisites, verificationEnvironment } from "./test-prerequisites";

const root = resolve(import.meta.dir, "../..");
const selected: string[] = [];
for await (const path of new Bun.Glob("test/support/**/*.test.ts").scan(root)) selected.push(path);
const env = verificationEnvironment(process.env);
await prepareTestPrerequisites(selected, env);
const child = Bun.spawn(["tsc", "-b", "--pretty", "false", ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await child.exited;
