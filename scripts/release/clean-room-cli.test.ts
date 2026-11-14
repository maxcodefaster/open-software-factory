import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { namespaceManifest, receiptPath } from "./clean-room-model";

const root = resolve(import.meta.dir, "../..");
const image = `registry.example.invalid/factory@sha256:${"a".repeat(64)}`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "factory-native-cleanroom-cli-"));
  const trace = join(directory, "trace");
  await writeFile(trace, "");
  for (const command of ["kubectl", "helm", "docker"])
    await writeFile(
      join(directory, command),
      `#!${process.execPath}
      await Bun.write(${JSON.stringify(trace)}, "unexpected external command");
      process.exit(2);
    `,
      { mode: 0o700 },
    );
  return {
    directory,
    trace,
    async run(args: string[]) {
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", resolve(import.meta.dir, "clean-room.ts"), ...args],
        {
          env: { ...process.env, PATH: `${directory}:${process.env["PATH"]}` },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, exit };
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("missing native commissioning refuses before any external client or installation action", async () => {
  const f = await fixture();
  try {
    const result = await f.run(["--factory-image", image, "--context", "owned-context"]);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("--native-fixture");
    expect(await readFile(f.trace, "utf8")).toBe("");
  } finally {
    await f.close();
  }
});

test("unreadable native input records failure without contacting Kubernetes, Docker or Helm", async () => {
  const f = await fixture();
  let ownedReceipt: string | undefined;
  try {
    const result = await f.run([
      "--factory-image",
      image,
      "--context",
      "owned-context",
      "--native-fixture",
      join(f.directory, "missing-native.json"),
    ]);
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("Native fixture JSON could not be read");
    expect(await readFile(f.trace, "utf8")).toBe("");
    ownedReceipt = /receipt (.+\/factory-cleanroom-[a-f0-9]{8}\.json)/.exec(result.stdout)?.[1];
    if (!ownedReceipt) throw Error("Owned failed commissioning receipt was not recorded");
    const receipt = JSON.parse(await readFile(ownedReceipt, "utf8")) as {
      namespace: string;
      namespaceUID: string | null;
      context: string;
      passed: boolean;
    };
    expect(ownedReceipt).toBe(resolve(root, receiptPath(receipt.namespace)));
    expect(receipt).toMatchObject({ namespaceUID: null, context: "owned-context", passed: false });
  } finally {
    if (ownedReceipt) await rm(ownedReceipt, { force: true });
    await f.close();
  }
});

test.each(["missing UID", "changed context"] as const)(
  "cleanup refuses %s before inventory or destructive commands",
  async (boundary) => {
    const f = await fixture();
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const namespace = `factory-cleanroom-${id}`;
    const file = resolve(root, receiptPath(namespace));
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          namespace,
          context: boundary === "changed context" ? "another-context" : "owned-context",
          namespaceUID: boundary === "missing UID" ? null : "original-namespace-uid",
        }),
        { flag: "wx", mode: 0o600 },
      );
      const result = await f.run(["--cleanup", namespace, "--context", "owned-context"]);
      expect(result.exit).toBe(2);
      expect(result.stderr).toContain("Original clean-room Namespace UID/context is unavailable");
      expect(await readFile(f.trace, "utf8")).toBe("");
    } finally {
      await rm(file, { force: true });
      await f.close();
    }
  },
);

test.each(["original", "replacement at deletion"] as const)(
  "cleanup uses only UID-preconditioned API deletion: %s",
  async (boundary) => {
    const f = await fixture();
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const namespace = `factory-cleanroom-${id}`;
    const file = resolve(root, receiptPath(namespace));
    const state = join(f.directory, "deleted.json");
    const namespaceObject = {
      metadata: { ...namespaceManifest(id, new Date()).metadata, uid: "original-namespace" },
    };
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          namespace,
          context: "owned-context",
          namespaceUID: "original-namespace",
        }),
        { flag: "wx", mode: 0o600 },
      );
      await writeFile(state, "[]");
      await writeFile(
        join(f.directory, "kubectl"),
        `#!${process.execPath}
        import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
        const args = process.argv.slice(2);
        const deleted = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
        let body;
        if (args.includes("--raw")) body = await Bun.stdin.json();
        appendFileSync(${JSON.stringify(f.trace)}, JSON.stringify({ args, body }) + "\\n");
        const ns = ${JSON.stringify(namespace)};
        const nsPath = "/api/v1/namespaces/" + ns;
        const role = ns + "-factory";
        const rolePath = "/apis/rbac.authorization.k8s.io/v1/clusterroles/" + role;
        const bindingPath = "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/" + role;
        if (args.includes("get")) {
          const kind = args[args.indexOf("get") + 1];
          const labels = { "app.kubernetes.io/name": "factory", "app.kubernetes.io/instance": "factory" };
          if (kind === "namespace") console.log(JSON.stringify(${JSON.stringify(namespaceObject)}));
          else if (kind === "namespaces") console.log(JSON.stringify({ items: deleted.includes(nsPath) ? [] : [${JSON.stringify(namespaceObject)}] }));
          else if (kind === "pvc") console.log(JSON.stringify({ items: [{ metadata: { name: "data-factory-postgres-0", uid: "original-claim" } }] }));
          else if (kind === "pv") console.log(JSON.stringify({ items: deleted.includes("/api/v1/persistentvolumes/owned-volume") ? [] : [{
            metadata: { name: "owned-volume", uid: "original-volume" },
            spec: { claimRef: { namespace: ns, uid: "original-claim" } }
          }] }));
          else if (kind === "clusterrole" || kind === "clusterrolebinding") {
            const path = kind === "clusterrole" ? rolePath : bindingPath;
            console.log(JSON.stringify({ items: deleted.includes(path) ? [] : [{
              metadata: { name: role, uid: "original-" + kind, labels }
            }] }));
          } else process.exit(2);
        } else if (args.includes("exec")) {
          process.stdout.write("");
        } else if (args.includes("delete") && args.includes("--raw")) {
          const path = args[args.indexOf("--raw") + 1];
          const uid = path === nsPath ? "original-namespace" :
            path === rolePath ? "original-clusterrole" :
            path === bindingPath ? "original-clusterrolebinding" :
            path === "/api/v1/persistentvolumes/owned-volume" ? "original-volume" : undefined;
          if (!uid || body?.preconditions?.uid !== uid) process.exit(3);
          if (${JSON.stringify(boundary)} === "replacement at deletion" && path === nsPath) process.exit(1);
          deleted.push(path);
          writeFileSync(${JSON.stringify(state)}, JSON.stringify(deleted));
          console.log("{}");
        } else if (!args.includes("wait")) process.exit(2);
      `,
        { mode: 0o700 },
      );
      const result = await f.run(["--cleanup", namespace, "--context", "owned-context"]);
      const trace = await readFile(f.trace, "utf8");
      expect(trace.includes("unexpected external command")).toBe(false);
      const calls = trace
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              args: string[];
              body?: { preconditions?: { uid?: string } };
            },
        );
      const deletions = calls.filter((call) => call.args.includes("delete"));
      expect(
        deletions.every((call) => call.args.includes("--raw") && !!call.body?.preconditions?.uid),
      ).toBe(true);
      expect(calls.some((call) => call.args.includes("uninstall"))).toBe(false);
      if (boundary === "replacement at deletion") {
        expect(result.exit).toBe(2);
        expect(deletions).toHaveLength(1);
        expect(deletions[0]?.body?.preconditions?.uid).toBe("original-namespace");
        expect(await readFile(state, "utf8")).toBe("[]");
      } else {
        expect(result.exit).toBe(0);
        expect(deletions).toHaveLength(4);
        const receipt = JSON.parse(await readFile(file, "utf8")) as {
          cleanupRerun: { state: string; remaining: string[] };
        };
        expect(receipt.cleanupRerun).toMatchObject({ state: "removed", remaining: [] });
      }
    } finally {
      await rm(file, { force: true });
      await f.close();
    }
  },
);
