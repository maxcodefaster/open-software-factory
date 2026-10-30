import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { factoryboxRuntimeImage } from "../../packages/runtime-kubernetes/src/factorybox-runtime";

test.skipIf(process.env["FACTORY_STORAGE_ADMISSION_LIVE"] !== "1")(
  "pinned Linux worker checks actual capacity once and refuses foreign storage before native allocation",
  async () => {
    const image = factoryboxRuntimeImage.parse(process.env["FACTORY_STORAGE_ADMISSION_IMAGE"]);
    const owner = crypto.randomUUID();
    const name = `factory-storage-admission-${owner}`;
    const program = await readFile(
      "packages/runtime-kubernetes/src/factorybox/storage-admission.py",
      "utf8",
    );
    const checks = await readFile(
      "packages/runtime-kubernetes/src/factorybox/storage-admission.test.py",
      "utf8",
    );
    const script =
      `scope = {"__name__": "capacity_admission"}\nexec(${JSON.stringify(program)}, scope)\n` +
      `globals().update({key:value for key,value in scope.items() if not key.startswith("__")})\n${checks}`;
    const started = performance.now();
    const child = Bun.spawn(
      [
        "docker",
        "run",
        "--pull=never",
        "--name",
        name,
        "--label",
        `factory.storage-admission-proof=${owner}`,
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--cpus=1",
        "--memory=64m",
        "--pids-limit=32",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777",
        "--user=0:0",
        "--entrypoint=python3",
        image,
        "-c",
        script,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    async function dispose() {
      const inspect = Bun.spawn(
        [
          "docker",
          "inspect",
          "--format",
          '{{index .Config.Labels "factory.storage-admission-proof"}}',
          name,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const label = (await new Response(inspect.stdout).text()).trim();
      if ((await inspect.exited) !== 0 || label !== owner)
        throw new Error("Storage admission proof cleanup ownership is unconfirmed");
      const cleanup = Bun.spawn(["docker", "rm", "--force", name], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await cleanup.exited) !== 0)
        throw new Error("Owned storage admission proof cleanup failed");
    }
    try {
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      console.log(output + error);
      console.log(
        JSON.stringify({ nativeImageStartAndChecksMs: Math.round(performance.now() - started) }),
      );
      expect(code).toBe(0);
      expect(error).toContain("Ran 6 tests");
      expect(error).toMatch(/\nOK\s*$/);
    } finally {
      await dispose();
    }
  },
  // Use the existing native lifecycle allowance, not a second cold-image cap.
  // The actual insufficient-capacity check has its own two-second assertion.
  420_000,
);
