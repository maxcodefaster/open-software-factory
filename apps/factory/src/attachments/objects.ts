import { S3Client } from "bun";
import { createHash } from "node:crypto";
import { CommandError } from "../command-error";

export type AttachmentObjects = {
  put(key: string, data: Uint8Array, mediaType: string): Promise<void>;
  read(key: string): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
};
export function attachmentDigest(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

export function createAttachmentObjects(): AttachmentObjects {
  const env = process.env;
  const bucket = env["FACTORY_ATTACHMENT_S3_BUCKET"];
  const endpoint = env["FACTORY_ATTACHMENT_S3_ENDPOINT"];
  let client: S3Client | undefined;
  function storage() {
    if (!bucket || !endpoint)
      throw new CommandError(
        "unavailable",
        "File storage is not configured. Ask your Factory administrator to configure the private attachment bucket.",
      );
    client ??= new S3Client({
      bucket,
      endpoint,
      region: env["FACTORY_ATTACHMENT_S3_REGION"] ?? "us-east-1",
      ...(env["FACTORY_ATTACHMENT_S3_ACCESS_KEY_ID"]
        ? { accessKeyId: env["FACTORY_ATTACHMENT_S3_ACCESS_KEY_ID"] }
        : {}),
      ...(env["FACTORY_ATTACHMENT_S3_SECRET_ACCESS_KEY"]
        ? { secretAccessKey: env["FACTORY_ATTACHMENT_S3_SECRET_ACCESS_KEY"] }
        : {}),
    });
    return client;
  }
  async function request(
    key: string,
    method: "GET" | "PUT" | "DELETE",
    data?: Uint8Array,
    mediaType?: string,
  ) {
    try {
      // Signed URLs remain server-local. Fetch supplies an actual cancellation
      // deadline instead of leaving a native upload alive after its authority expires.
      const url = storage().presign(key, {
        method,
        expiresIn: 60,
        ...(mediaType ? { type: mediaType } : {}),
      });
      const response = await fetch(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        ...(data ? { body: new Uint8Array(data).buffer } : {}),
        ...(mediaType ? { headers: { "content-type": mediaType } } : {}),
      });
      if (!response.ok && response.status !== 404) {
        await response.body?.cancel();
        throw new CommandError(
          "unavailable",
          `Private file storage returned ${response.status}. No file was published.`,
        );
      }
      return response;
    } catch (cause) {
      if (cause instanceof CommandError) throw cause;
      // Never relay SDK/network errors containing signed URLs to a browser or model.
      throw new CommandError(
        "unavailable",
        "The private file storage connection could not be confirmed.",
      );
    }
  }
  async function read(key: string, optional = false) {
    const response = await request(key, "GET");
    if (response.status === 404) {
      await response.body?.cancel();
      if (optional) return undefined;
      throw new CommandError("unavailable", "The stored attachment is unavailable.");
    }
    const maximum = 125 * 1024 * 1024;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Attachment object body is missing");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maximum) {
          await reader.cancel();
          throw new Error("Stored attachment exceeds its read bound");
        }
        chunks.push(chunk.value);
      }
      return new Uint8Array(Buffer.concat(chunks));
    } catch {
      throw new CommandError(
        "unavailable",
        "The stored attachment could not be read within its storage bound.",
      );
    } finally {
      reader.releaseLock();
    }
  }
  return {
    async put(key, data, mediaType) {
      // Keys include the installation, immutable attachment ID and content hash.
      // Reconciliation only accepts the same bytes, never a replacement identity.
      const previous = await read(key, true);
      if (previous) {
        if (attachmentDigest(previous) !== attachmentDigest(data))
          throw new Error("Stored attachment does not match its immutable content");
        return;
      }
      const response = await request(key, "PUT", data, mediaType);
      await response.body?.cancel();
      if (!response.ok || attachmentDigest((await read(key))!) !== attachmentDigest(data))
        throw new Error("Attachment write could not be confirmed");
    },
    async read(key) {
      return (await read(key))!;
    },
    async remove(key) {
      const response = await request(key, "DELETE");
      await response.body?.cancel();
    },
  };
}
