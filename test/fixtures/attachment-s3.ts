import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const attachmentS3Image =
  "docker.io/dxflrs/garage@sha256:866bd13ed2038ba7e7190e840482bc27234c4afaf77be8cfa439ae088c1e4690";

async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status) throw new Error(`Owned attachment S3 ${args[0]} failed: ${error.slice(-1000)}`);
  return output.trim();
}

export async function ownedAttachmentS3() {
  const id = crypto.randomUUID();
  const name = `factory-attachment-proof-${id}`;
  const directory = join(tmpdir(), name);
  const key = `GK${randomBytes(16).toString("hex")}`;
  const secret = randomBytes(32).toString("hex");
  const saved = new Map<string, string | undefined>();
  let created = false;
  async function dispose() {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (created) {
      const owner = await docker(
        "inspect",
        "--format",
        '{{index .Config.Labels "factory.attachment-proof"}}',
        name,
      );
      if (owner !== id) throw new Error("Refusing to remove an unowned S3 proof container");
      await docker("rm", "-f", name);
    }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const configuration = join(directory, "garage.toml");
    await writeFile(
      configuration,
      `metadata_dir="/tmp/meta"\ndata_dir="/tmp/data"\ndb_engine="sqlite"\nreplication_factor=1\nrpc_bind_addr="127.0.0.1:3901"\nrpc_public_addr="127.0.0.1:3901"\nrpc_secret="${randomBytes(32).toString("hex")}"\n[s3_api]\ns3_region="garage"\napi_bind_addr="0.0.0.0:3900"\nroot_domain=".s3.garage.localhost"\n`,
      { mode: 0o600 },
    );
    await docker(
      "create",
      "--name",
      name,
      "--label",
      `factory.attachment-proof=${id}`,
      "-p",
      "127.0.0.1::3900",
      "-v",
      `${configuration}:/etc/garage.toml:ro`,
      "-e",
      `GARAGE_DEFAULT_ACCESS_KEY=${key}`,
      "-e",
      `GARAGE_DEFAULT_SECRET_KEY=${secret}`,
      "-e",
      "GARAGE_DEFAULT_BUCKET=factory-attachments",
      attachmentS3Image,
      "/garage",
      "server",
      "--single-node",
      "--default-bucket",
    );
    created = true;
    await docker("start", name);
    const port = (await docker("port", name, "3900/tcp")).split(":").at(-1);
    const endpoint = `http://127.0.0.1:${port}`;
    const env = {
      FACTORY_ATTACHMENT_S3_ENDPOINT: endpoint,
      FACTORY_ATTACHMENT_S3_BUCKET: "factory-attachments",
      FACTORY_ATTACHMENT_S3_REGION: "garage",
      FACTORY_ATTACHMENT_S3_ACCESS_KEY_ID: key,
      FACTORY_ATTACHMENT_S3_SECRET_ACCESS_KEY: secret,
    };
    for (const [name, value] of Object.entries(env)) {
      saved.set(name, process.env[name]);
      process.env[name] = value;
    }
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        await fetch(endpoint, { signal: AbortSignal.timeout(1000) });
        ready = true;
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    if (!ready) throw new Error("Owned attachment S3 did not start");
    return { endpoint, image: attachmentS3Image, dispose };
  } catch (cause) {
    await dispose();
    throw cause;
  }
}
