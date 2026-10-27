import { S3Client } from "bun";
import { createHash } from "node:crypto";
import { CommandError } from "../command-error";

export type PrivateObjects = {
  put(key: string, data: Uint8Array, mediaType: string): Promise<void>;
  read(key: string): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
  open(key: string, range?: { start: number; end: number }): Promise<Response>;
};
export function objectDigest(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

export function objectStorageConfigured() {
  return Boolean(
    process.env["FACTORY_OBJECT_S3_BUCKET"] && process.env["FACTORY_OBJECT_S3_ENDPOINT"],
  );
}

export function createPrivateObjects(): PrivateObjects {
  const env = process.env;
  const bucket = env["FACTORY_OBJECT_S3_BUCKET"];
  const endpoint = env["FACTORY_OBJECT_S3_ENDPOINT"];
  let client: S3Client | undefined;
  function storage() {
    if (!bucket || !endpoint)
      throw new CommandError(
        "unavailable",
        "Factory file storage is unavailable. Check the installation's object storage service.",
      );
    client ??= new S3Client({
      bucket,
      endpoint,
      region: env["FACTORY_OBJECT_S3_REGION"] ?? "garage",
      ...(env["FACTORY_OBJECT_S3_ACCESS_KEY_ID"]
        ? { accessKeyId: env["FACTORY_OBJECT_S3_ACCESS_KEY_ID"] }
        : {}),
      ...(env["FACTORY_OBJECT_S3_SECRET_ACCESS_KEY"]
        ? { secretAccessKey: env["FACTORY_OBJECT_S3_SECRET_ACCESS_KEY"] }
        : {}),
    });
    return client;
  }
  async function request(
    key: string,
    method: "GET" | "PUT" | "DELETE",
    data?: Uint8Array,
    mediaType?: string,
    range?: { start: number; end: number },
    streaming = false,
  ) {
    const connection = streaming ? new AbortController() : undefined;
    const timer = connection ? setTimeout(() => connection.abort(), 30_000) : undefined;
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
        signal: connection?.signal ?? AbortSignal.timeout(30_000),
        ...(data ? { body: new Uint8Array(data).buffer } : {}),
        headers: {
          ...(mediaType ? { "content-type": mediaType } : {}),
          ...(range ? { range: `bytes=${range.start}-${range.end}` } : {}),
          ...(method === "PUT" ? { "if-none-match": "*" } : {}),
        },
      });
      if (
        !response.ok &&
        response.status !== 404 &&
        !(method === "PUT" && response.status === 412)
      ) {
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
    } finally {
      // Bound stream establishment, not a human's video playback time. Cancelling
      // the returned body still cancels the upstream read through native streams.
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  async function read(key: string, optional = false) {
    const response = await request(key, "GET");
    if (response.status === 404) {
      await response.body?.cancel();
      if (optional) return undefined;
      throw new CommandError("unavailable", "The stored file is unavailable.");
    }
    const maximum = 125 * 1024 * 1024;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Private object body is missing");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maximum) {
          await reader.cancel();
          throw new Error("Stored object exceeds its read bound");
        }
        chunks.push(chunk.value);
      }
      return new Uint8Array(Buffer.concat(chunks));
    } catch {
      throw new CommandError(
        "unavailable",
        "The stored file could not be read within its storage bound.",
      );
    } finally {
      reader.releaseLock();
    }
  }
  return {
    open(key, range) {
      return request(key, "GET", undefined, undefined, range, true);
    },
    async put(key, data, mediaType) {
      // Callers record installation-scoped immutable file identities before I/O.
      // Reconciliation only accepts the same bytes, never a replacement identity.
      const previous = await read(key, true);
      if (previous) {
        if (objectDigest(previous) !== objectDigest(data))
          throw new Error("Stored file does not match its immutable content");
        return;
      }
      const response = await request(key, "PUT", data, mediaType);
      await response.body?.cancel();
      const observed = await read(key);
      if (observed && objectDigest(observed) !== objectDigest(data))
        throw new Error("Stored file does not match its immutable content");
      if (!response.ok && response.status !== 412)
        throw new Error("File write could not be confirmed");
    },
    async read(key) {
      const data = await read(key);
      if (!data) throw new CommandError("not-found", "The retained file is unavailable.");
      return data;
    },
    async remove(key) {
      const response = await request(key, "DELETE");
      await response.body?.cancel();
    },
  };
}
