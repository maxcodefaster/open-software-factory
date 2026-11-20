import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { nativeInstallationFixture } from "../../test/fixtures/native-installation";
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

test.each(["unconfirmed install", "unconfirmed public CA"] as const)(
  "managed commissioning never adopts trust or reports browser acceptance after %s",
  async (boundary) => {
    const f = await fixture();
    let ownedReceipt: string | undefined;
    try {
      const token = join(f.directory, "token");
      await writeFile(token, "owned-private-provisioner-token", { mode: 0o600 });
      const input = join(f.directory, "native.json");
      const base = nativeInstallationFixture();
      await writeFile(
        input,
        JSON.stringify({
          schema: 1,
          tlsMode: "managed",
          factoryOrigin: "https://factory.owned-cleanroom.invalid",
          forgejoOrigin: "https://git.owned-cleanroom.invalid",
          ingressClass: "owned",
          ingressNamespaceLabels: { "kubernetes.io/metadata.name": "owned-ingress" },
          provisionerTokenFile: token,
          configuration: {
            profile: base.profile,
            runtime: base.runtime,
            workloadImage: base.workloadImage,
            workerSelector: base.workerSelector,
            resources: base.resources,
            egressHosts: ["git.owned-cleanroom.invalid"],
          },
        }),
        { mode: 0o600 },
      );
      const chart = join(f.directory, "owned-chart.tgz");
      await writeFile(chart, "synthetic chart handled only by the owned Helm stub");
      const defaults = Bun.YAML.parse(
        await readFile(join(root, "deploy/helm/factory/values.yaml"), "utf8"),
      ) as Record<string, unknown>;
      defaults["image"] = image;
      const state = join(f.directory, "namespace.json");
      const stub = `
        import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
        const args = process.argv.slice(2);
        appendFileSync(${JSON.stringify(f.trace)}, JSON.stringify({ tool: process.argv[1].split("/").at(-1), args }) + "\\n");
      `;
      await writeFile(
        join(f.directory, "helm"),
        `#!${process.execPath}
        ${stub}
        if (args.includes("version")) console.log("v4.2.2");
        else if (args.includes("show") && args.includes("chart"))
          console.log(JSON.stringify({ name: "factory", version: "0.0.0-owned", appVersion: "0.0.0-owned" }));
        else if (args.includes("show") && args.includes("values"))
          console.log(${JSON.stringify(JSON.stringify(defaults))});
        else if (args.includes("template")) console.log("");
        else if (args.includes("install")) {
          const values = Bun.YAML.parse(readFileSync(args[args.indexOf("--values") + 1], "utf8"));
          if (values.ingress.tlsSecret !== "") process.exit(3);
          process.exit(${boundary === "unconfirmed install" ? 1 : 0});
        } else process.exit(2);
        `,
        { mode: 0o700 },
      );
      await writeFile(
        join(f.directory, "kubectl"),
        `#!${process.execPath}
        ${stub}
        if (args.includes("version")) console.log(JSON.stringify({
          clientVersion: { gitVersion: "v1.35.6" }, serverVersion: { gitVersion: "v1.35.6" }
        }));
        else if (args.includes("create") && args.includes("-f")) {
          const body = await Bun.stdin.json();
          if (body.kind === "Namespace") {
            body.metadata.uid = "original-managed-namespace";
            writeFileSync(${JSON.stringify(state)}, JSON.stringify(body));
            console.log(JSON.stringify(body));
          } else if (body.kind === "Secret" && !body.metadata.name.endsWith("-ingress-tls")) {
            appendFileSync(${JSON.stringify(f.trace)}, JSON.stringify({ createdSecretKeys: Object.keys(body.stringData) }) + "\\n");
            console.log("secret/" + body.metadata.name);
          } else process.exit(3);
        } else if (args.includes("get")) {
          const kind = args[args.indexOf("get") + 1];
          if (kind === "nodes") console.log(JSON.stringify({ items: [{
            metadata: { name: "owned-node" }, status: { allocatable: { memory: "100Gi", cpu: "16" } }
          }] }));
          else if (kind === "pods" || kind === "namespaces" || kind === "ingresses")
            console.log(JSON.stringify({ items: [] }));
          else if (kind === "namespace") {
            try { console.log(readFileSync(${JSON.stringify(state)}, "utf8")); }
            catch { process.exit(1); }
          } else if (kind === "secret") {
            console.error("synthetic-private-diagnostic-must-not-leak");
            process.exit(1);
          } else process.exit(2);
        } else process.exit(2);
        `,
        { mode: 0o700 },
      );
      const result = await f.run([
        "--chart",
        chart,
        "--native-fixture",
        input,
        "--context",
        "owned-context",
        "--keep",
      ]);
      expect(result.exit).toBe(1);
      ownedReceipt = /receipt (.+\/factory-cleanroom-[a-f0-9]{8}\.json)/.exec(result.stdout)?.[1];
      if (!ownedReceipt) throw Error("Owned managed commissioning receipt was not recorded");
      const text = await readFile(ownedReceipt, "utf8");
      const receipt = JSON.parse(text);
      expect(receipt.native.tlsMode).toBe("managed");
      expect(receipt.namespaceUID).toBe("original-managed-namespace");
      expect(receipt.cleanup.state).toBe("kept");
      expect(receipt.passed).toBe(false);
      expect(receipt.checks.some((check: { name: string }) => check.name === "sign-in")).toBe(
        false,
      );
      const trace = (await readFile(f.trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const trustReads = trace.filter((call) => call.args?.includes("secret"));
      if (boundary === "unconfirmed install") {
        expect(trustReads).toHaveLength(0);
        expect(
          receipt.checks.find((check: { name: string }) => check.name === "install").status,
        ).toBe("failed");
      } else {
        expect(trustReads).toHaveLength(1);
        expect(trustReads[0].args.at(-1)).toStartWith("jsonpath=");
        expect(trustReads[0].args.at(-1)).not.toContain("ca.key");
        expect(
          receipt.checks.find((check: { name: string }) => check.name === "public-trust").status,
        ).toBe("failed");
      }
      expect(
        trace.filter((call) => call.createdSecretKeys).map((call) => call.createdSecretKeys),
      ).toEqual([["configuration.json"], ["token"]]);
      expect(result.stdout + result.stderr + text).not.toContain("synthetic-private-diagnostic");
      expect(result.stdout + result.stderr + text).not.toContain("owned-private-provisioner-token");
    } finally {
      if (ownedReceipt) await rm(ownedReceipt, { force: true });
      await f.close();
    }
  },
  15_000,
);

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
