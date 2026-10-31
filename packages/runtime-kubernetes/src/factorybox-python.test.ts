import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { runCommand } from "./command";

const directory = resolve(import.meta.dir, "factorybox");
for (const files of [
  ["initialize_store_test.py"],
  ["inspect_store_test.py"],
  ["retire_export_test.py"],
  ["consumer_test.py", "consumer.py"],
  ["prepare_test.py", "prepare.py"],
])
  test(`Factory Python ownership and recovery controls: ${files[0]}`, async () => {
    const result = await runCommand(["python3", ...files.map((file) => resolve(directory, file))]);
    expect(result.stderr).toContain("OK");
    expect(result.exitCode).toBe(0);
  });
