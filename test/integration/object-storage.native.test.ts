import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseAllDocuments } from "yaml";
import { objectDigest, createPrivateObjects } from "../../apps/factory/src/storage/objects";
import { requireObjectStorage } from "../../apps/factory/src/storage/bootstrap";
import { createAttachmentStore } from "../../apps/factory/src/attachments/store";
import { createReviewMedia } from "../../apps/factory/src/review/media";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { ownedPostgresServer } from "../fixtures/postgres-server";
import { fixtureValue } from "../fixtures/value";

type Resource = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; uid?: string; labels?: Record<string, string> };
  data?: Record<string, string>;
  status?: { conditions?: Array<{ type: string; status: string }> };
};

test("the chart-owned bucket retains attachments and ranged QA media through replacement with unchanged credentials", async () => {
  const owner = crypto.randomUUID();
  const namespace = `factory-files-proof-${owner}`;
  const directory = resolve(".factory/test-results/object-storage", owner);
  await mkdir(directory, { recursive: true });
  const context = (await runCommand(["kubectl", "config", "current-context"])).stdout.trim();
  if (!context) throw new Error("Select an explicit native Kubernetes context");
  const kubectl = ["kubectl", "--context", context, "--namespace", namespace];
  const label = "factory.dev/object-storage-proof";
  const helm = [
    "helm",
    "template",
    "files",
    "deploy/helm/factory",
    "--namespace",
    namespace,
    "--kube-context",
    context,
    "--values",
    "deploy/helm/factory/values.local.yaml",
    "--set-string",
    "image=unused-object-proof:local",
    "--set",
    "objectStorage.size=1Gi",
    "--set-string",
    `factorybox.image=registry.invalid/worker@sha256:${"a".repeat(64)}`,
    "--set-string",
    `factorybox.executableSHA256=${"b".repeat(64)}`,
    "--set",
    "factorybox.architecture=amd64",
    "--set",
    "factorybox.nodeName=unused-owned-node",
    "--set",
    "factorybox.kernel=unused-owned-kernel",
  ];
  async function command(args: string[], input?: string) {
    const result = await runCommand(args, input, {
      timeoutMS: 1_200_000,
      outputBytes: 1024 * 1024,
    });
    if (result.exitCode !== 0)
      throw new Error(`Owned file-store operation failed: ${result.stderr.slice(-1500)}`);
    return result.stdout;
  }
  const documents = (text: string) =>
    parseAllDocuments(text).map((document) => {
      if (document.errors.length) throw document.errors[0];
      return document.toJSON() as Resource;
    });
  const rendered = documents(await command(helm));
  const selected = rendered.filter(
    (resource) =>
      resource.metadata.name === "files-objects" ||
      ["files-credentials", "files-openbao-tls"].includes(resource.metadata.name),
  );
  const credential = selected.find(
    (resource) => resource.kind === "Secret" && resource.metadata.name === "files-objects",
  );
  if (!credential?.data) throw new Error("Chart did not supply file storage credentials");
  let namespaceUID: string | undefined;
  let forward: ReturnType<typeof Bun.spawn> | undefined;
  let f: Awaited<ReturnType<typeof candidateReviewFixture>> | undefined;
  let postgres: Awaited<ReturnType<typeof ownedPostgresServer>> | undefined;
  const saved = new Map<string, string | undefined>();
  const setting = (name: string, value: string) => {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    process.env[name] = value;
  };
  async function connect() {
    if (forward) {
      forward.kill();
      await forward.exited;
    }
    forward = Bun.spawn(
      [...kubectl, "port-forward", "service/files-objects", "0:3900", "--address", "127.0.0.1"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = forward.stdout;
    if (typeof output === "number" || !output) throw new Error("Missing owned storage forward");
    const reader = output.getReader();
    const deadline = AbortSignal.timeout(30_000);
    try {
      let text = "";
      for (;;) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            deadline.addEventListener(
              "abort",
              () => reject(new Error("Storage forward timed out")),
              {
                once: true,
              },
            ),
          ),
        ]);
        if (chunk.done) throw new Error("Owned storage forward exited");
        text += new TextDecoder().decode(chunk.value);
        const port = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(text)?.[1];
        if (port) {
          setting("FACTORY_OBJECT_S3_ENDPOINT", `http://127.0.0.1:${port}`);
          return;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  async function pod() {
    return JSON.parse(
      await command([...kubectl, "get", "pod", "files-objects-0", "-o", "json"]),
    ) as Resource;
  }
  async function cleanupNamespace(uid: string) {
    const current = JSON.parse(
      await command([...kubectl, "get", "namespace", namespace, "-o", "json"]),
    ) as Resource;
    if (current.metadata.uid !== uid || current.metadata.labels?.[label] !== owner)
      throw new Error("Refusing to delete an unowned file-store proof Namespace");
    await command(
      [...kubectl, "delete", "--raw", `/api/v1/namespaces/${namespace}`, "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "DeleteOptions",
        preconditions: { uid },
      }),
    );
  }
  try {
    const created = JSON.parse(
      await command(
        [...kubectl, "create", "-f", "-", "-o", "json"],
        JSON.stringify({
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name: namespace, labels: { [label]: owner } },
        }),
      ),
    ) as Resource;
    namespaceUID = created.metadata.uid;
    await command(
      [...kubectl, "apply", "-f", "-"],
      JSON.stringify({ apiVersion: "v1", kind: "List", items: selected }),
    );
    await command([...kubectl, "rollout", "status", "statefulset/files-objects", "--timeout=20m"]);
    for (const [name, value] of Object.entries({
      FACTORY_OBJECT_S3_BUCKET: "factory",
      FACTORY_OBJECT_S3_REGION: "garage",
      FACTORY_OBJECT_S3_ACCESS_KEY_ID: Buffer.from(
        fixtureValue(credential.data["access-key-id"], 'credential.data["access-key-id"]'),
        "base64",
      ).toString(),
      FACTORY_OBJECT_S3_SECRET_ACCESS_KEY: Buffer.from(
        fixtureValue(credential.data["secret-access-key"], 'credential.data["secret-access-key"]'),
        "base64",
      ).toString(),
    }))
      setting(name, value);
    await connect();
    if (!process.env["FACTORY_TEST_POSTGRES"]) {
      postgres = await ownedPostgresServer();
      setting("FACTORY_TEST_POSTGRES", JSON.stringify(postgres.identity));
    }
    f = await candidateReviewFixture();
    const objects = createPrivateObjects();
    await requireObjectStorage(f.database, directory, objects);
    const attachments = createAttachmentStore(f.database, objects, async (bytes) => ({
      text: new TextDecoder().decode(bytes),
      previews: [],
    }));
    const id = crypto.randomUUID();
    const bytes = new TextEncoder().encode("Attachment in the chart-owned file store.");
    await attachments.begin(f.userID, {
      id,
      projectId: f.projectID,
      name: "retained.txt",
      mediaType: "text/plain",
      bytes: bytes.byteLength,
      sha256: objectDigest(bytes),
    });
    await attachments.upload(f.userID, id, bytes);
    const media = createReviewMedia(f.database, objects);
    const recordingID = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.review_media(id,change_id,review_id,kind,commit_sha,state)
      VALUES(${recordingID},${f.changeID},${f.reviewID},'recording',${f.commit},'intended')`;
    const video = new TextEncoder().encode("Retained QA recording with native byte ranges.");
    await media.publish(recordingID, video, 2000);
    const [storage] = await f.database.client<{ id: string }[]>`
      SELECT id FROM factory.attachment_storage WHERE singleton`;
    const videoKey = `factory-review/${fixtureValue(storage, "storage").id}/${recordingID}`;
    const endpoint = fixtureValue(
      process.env["FACTORY_OBJECT_S3_ENDPOINT"],
      'process.env["FACTORY_OBJECT_S3_ENDPOINT"]',
    );
    expect((await fetch(`${endpoint}/factory/${videoKey}`)).status).toBe(403);
    expect((await fetch(`${endpoint}/factory`)).status).toBe(403);
    const range = await media.read(f.changeID, f.userID, recordingID, "bytes=0-7");
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("Retained");
    expect(range.headers.get("cache-control")).toBe("private, no-store");
    const upgraded = documents(await command([...helm, "--dry-run=server", "--is-upgrade"]));
    const retained = upgraded.find(
      (resource) => resource.kind === "Secret" && resource.metadata.name === "files-objects",
    );
    expect(retained?.data).toEqual(credential.data);
    const previous = await pod();
    expect(previous.metadata.labels?.["app.kubernetes.io/instance"]).toBe("files");
    expect(previous.metadata.uid).toBeTruthy();
    await command(
      [
        ...kubectl,
        "delete",
        "--raw",
        `/api/v1/namespaces/${namespace}/pods/files-objects-0`,
        "-f",
        "-",
      ],
      JSON.stringify({
        apiVersion: "v1",
        kind: "DeleteOptions",
        preconditions: { uid: previous.metadata.uid },
      }),
    );
    const deadline = Date.now() + 120_000;
    for (;;) {
      const current = await pod().catch(() => undefined);
      if (
        current?.metadata.uid !== previous.metadata.uid &&
        current?.status?.conditions?.some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        )
      )
        break;
      if (Date.now() >= deadline) throw new Error("Owned object store did not recover its Pod");
      await Bun.sleep(500);
    }
    await connect();
    const recovered = createPrivateObjects();
    await requireObjectStorage(f.database, directory, recovered);
    const recoveredAttachments = createAttachmentStore(f.database, recovered);
    expect(await (await recoveredAttachments.read(f.userID, id)).text()).toBe(
      new TextDecoder().decode(bytes),
    );
    const recoveredMedia = createReviewMedia(f.database, recovered);
    expect(await (await recoveredMedia.read(f.changeID, f.userID, recordingID, null)).text()).toBe(
      new TextDecoder().decode(video),
    );
    expect((await media.read(f.changeID, f.userID, recordingID, "bytes=0-999")).status).toBe(416);
    await recovered.remove(videoKey);
    expect(await (await recoveredAttachments.read(f.userID, id)).text()).toContain("Attachment");
    // Missing retained credentials must not produce a new access identity.
    await command([...kubectl, "delete", "secret", "files-objects"]);
    const missing = await runCommand([...helm, "--dry-run=server", "--is-upgrade"]);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("retained object storage credentials are missing");
    await writeFile(
      resolve(directory, "result.json"),
      JSON.stringify({
        owner,
        context,
        namespace,
        attachments: true,
        rangedQA: true,
        replacement: true,
        retainedCredentials: true,
      }),
    );
  } catch (cause) {
    if (namespaceUID) {
      const diagnostics = await runCommand([...kubectl, "get", "pods,events", "-o", "json"]);
      await writeFile(resolve(directory, "failure.json"), diagnostics.stdout);
    }
    throw cause;
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (forward) {
      forward.kill();
      await forward.exited;
    }
    await f?.dispose();
    await postgres?.dispose();
    if (namespaceUID) await cleanupNamespace(namespaceUID);
  }
}, 1_440_000);
