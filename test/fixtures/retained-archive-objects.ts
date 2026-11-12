import {
  createPrivateObjects,
  objectDigest,
  type PrivateObjects,
} from "../../apps/factory/src/storage/objects";

// Explicit native lane only. Use the installation's existing private store,
// with exact test-owned content keys. Never print or persist its credentials.
export async function retainedArchiveObjects(namespace: string) {
  if (!/^[a-z0-9-]+$/.test(namespace))
    throw new Error("Explicit archive fixture namespace required");
  async function kubernetes(args: string[]) {
    const child = Bun.spawn(["kubectl", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (status) throw new Error("Archive fixture Kubernetes read failed");
    return JSON.parse(stdout);
  }
  const deployment = await kubernetes([
    "get",
    "deployment",
    "factory",
    "-n",
    namespace,
    "-o",
    "json",
  ]);
  const env = deployment.spec.template.spec.containers.find(
    (container: { name: string }) => container.name === "factory",
  )?.env;
  const credentials: Record<string, string> = {};
  for (const name of ["FACTORY_OBJECT_S3_ACCESS_KEY_ID", "FACTORY_OBJECT_S3_SECRET_ACCESS_KEY"]) {
    const ref = env?.find((entry: { name: string }) => entry.name === name)?.valueFrom
      ?.secretKeyRef;
    if (!ref) throw new Error("Existing private object credential reference is unavailable");
    const secret = await kubernetes(["get", "secret", ref.name, "-n", namespace, "-o", "json"]);
    credentials[name] = Buffer.from(secret.data[ref.key], "base64").toString();
  }
  const forward = Bun.spawn(
    [
      "kubectl",
      "port-forward",
      "-n",
      namespace,
      "service/factory-objects",
      ":3900",
      "--address=127.0.0.1",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const reader = forward.stdout.getReader();
  let port: string | undefined;
  try {
    const timeout = AbortSignal.timeout(15_000);
    let output = "";
    while (!port) {
      timeout.throwIfAborted();
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          timeout.addEventListener(
            "abort",
            () => reject(new Error("Archive object forward timed out")),
            { once: true },
          ),
        ),
      ]);
      if (next.done) throw new Error("Archive object forward ended");
      output += new TextDecoder().decode(next.value);
      port = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(output)?.[1];
      if (output.length > 4096) throw new Error("Archive forward output exceeds fixture bound");
    }
  } catch (cause) {
    forward.kill();
    await forward.exited;
    throw cause;
  } finally {
    reader.releaseLock();
  }
  const values = {
    ...credentials,
    FACTORY_OBJECT_S3_BUCKET: "factory",
    FACTORY_OBJECT_S3_REGION: "garage",
    FACTORY_OBJECT_S3_ENDPOINT: `http://127.0.0.1:${port}`,
  };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  const base = createPrivateObjects();
  const owned = new Map<string, string>();
  const objects: PrivateObjects = {
    ...base,
    async put(key, bytes, type) {
      if (!key.startsWith("session-archives/v1/"))
        throw new Error("Archive fixture write outside owned prefix");
      const hash = objectDigest(bytes);
      if (owned.has(key) && owned.get(key) !== hash)
        throw new Error("Archive fixture identity changed");
      owned.set(key, hash);
      await base.put(key, bytes, type);
    },
  };
  return {
    objects,
    async dispose() {
      try {
        for (const [key, hash] of owned) {
          if (objectDigest(await base.read(key)) !== hash)
            throw new Error("Archive fixture cleanup ownership differs");
          await base.remove(key);
        }
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        forward.kill();
        await forward.exited;
      }
    },
  };
}
