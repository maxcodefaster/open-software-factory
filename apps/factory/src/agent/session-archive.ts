import type { SessionTransferData } from "@opencode/client";
import { z } from "zod";
import upstream from "../../../../upstream.json";
import { objectDigest, type PrivateObjects } from "../storage/objects";
import type { createOpenCodeClient } from "./opencode-client";

type Client = ReturnType<typeof createOpenCodeClient>;
const maximumBytes = 125 * 1024 ** 2;
const chunkBytes = 1024 ** 2;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.strictObject({
  key: z.string(),
  sha256: digest,
  bytes: z.number().int().positive().max(chunkBytes),
});
const manifestSchema = z.strictObject({
  version: z.literal(1),
  producer: z.strictObject({ name: z.literal("opencode"), version: z.string() }),
  checkpoint: z.strictObject({
    turnID: z.uuid(),
    runtimeAttemptID: z.uuid(),
    sessionID: z.string(),
    promptID: z.string(),
    throughMessageID: z.string(),
  }),
  source: z.record(z.string(), z.unknown()),
  limitations: z.literal(
    "completed-messages-only; external bytes and execution state not checkpointed",
  ),
  sha256: digest,
  bytes: z.number().int().positive().max(maximumBytes),
  chunks: z.array(reference).min(1).max(125),
});
export type SessionArchiveManifest = z.infer<typeof manifestSchema>;
export type SessionArchiveCheckpoint = Omit<
  SessionArchiveManifest["checkpoint"],
  "throughMessageID"
>;

// Native JSON remains the import format. Chunking keeps large tool results and
// inline media in private object storage, never in the product database.
export async function saveNativeSessionArchive(
  client: Client,
  objects: PrivateObjects,
  checkpoint: SessionArchiveCheckpoint,
  source: Record<string, unknown>,
) {
  const producer = await client.server.info({ signal: AbortSignal.timeout(5_000) });
  if (producer.version !== upstream.openCode.version)
    throw new Error("Session archive requires the pinned OpenCode producer");
  const native = await client.session.export(
    // Native sanitized exports replace conversation/tool text and are unsuitable
    // for recovery. This payload is private; never expose it in diagnostics.
    { sessionID: checkpoint.sessionID, sanitize: false },
    { signal: AbortSignal.timeout(30_000) },
  );
  if (native.info.id !== checkpoint.sessionID)
    throw new Error("Session export returned another Session");
  const start = native.messages.findIndex((message) => message.id === checkpoint.promptID);
  if (start < 0 || native.messages[start]?.type !== "user")
    throw new Error("Completed checkpoint input is missing from native export");
  // Retry may observe a later turn. Never label that later history as this
  // checkpoint. Native exports are chronological and omit unfinished messages.
  let end = native.messages.findIndex((message, index) => index > start && message.type === "user");
  if (end < 0) end = native.messages.length;
  const messages = native.messages.slice(0, end);
  const completed = messages
    .slice(start + 1)
    .some(
      (message) =>
        message.type === "assistant" &&
        message.time.completed !== undefined &&
        message.finish === "stop",
    );
  if (!completed) throw new Error("Native export has no completed turn for this checkpoint");
  const through = messages.at(-1);
  if (!through) throw new Error("Native checkpoint is empty");
  const data: SessionTransferData = { info: native.info, messages };
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  if (bytes.byteLength > maximumBytes)
    throw new Error("Native session archive exceeds its storage bound");
  const sha256 = objectDigest(bytes);
  const prefix = `session-archives/v1/${checkpoint.turnID}/${sha256}`;
  const chunks: SessionArchiveManifest["chunks"] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    const chunk = bytes.slice(offset, offset + chunkBytes);
    const hash = objectDigest(chunk);
    const key = `${prefix}/${chunks.length}-${hash}.json.part`;
    await objects.put(key, chunk, "application/octet-stream");
    chunks.push({ key, sha256: hash, bytes: chunk.byteLength });
  }
  const manifest = manifestSchema.parse({
    version: 1,
    producer: { name: "opencode", version: producer.version },
    checkpoint: {
      turnID: checkpoint.turnID,
      runtimeAttemptID: checkpoint.runtimeAttemptID,
      sessionID: checkpoint.sessionID,
      promptID: checkpoint.promptID,
      throughMessageID: through.id,
    },
    source,
    limitations: "completed-messages-only; external bytes and execution state not checkpointed",
    sha256,
    bytes: bytes.byteLength,
    chunks,
  });
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestSHA256 = objectDigest(manifestBytes);
  const key = `${prefix}/${manifestSHA256}.manifest.json`;
  await objects.put(key, manifestBytes, "application/json");
  return { key, manifestSHA256, manifest, summary: summarizeNativeSession(messages.slice(start)) };
}

export async function readNativeSessionArchive(
  objects: PrivateObjects,
  key: string,
  sha256: string,
) {
  if (
    !/^session-archives\/v1\/[a-f0-9-]{36}\/[a-f0-9]{64}\/[a-f0-9]{64}\.manifest\.json$/.test(key)
  )
    throw new Error("Session archive pointer is outside private archive storage");
  const bytes = await objects.read(key);
  if (objectDigest(bytes) !== sha256) throw new Error("Session archive manifest checksum differs");
  const manifest = manifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  const prefix = key.slice(0, key.lastIndexOf("/"));
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (const [index, ref] of manifest.chunks.entries()) {
    if (ref.key !== `${prefix}/${index}-${ref.sha256}.json.part`)
      throw new Error("Session archive chunk is outside its checkpoint");
    const chunk = await objects.read(ref.key);
    if (chunk.byteLength !== ref.bytes || objectDigest(chunk) !== ref.sha256)
      throw new Error("Session archive chunk checksum differs");
    size += chunk.byteLength;
    if (size > manifest.bytes) throw new Error("Session archive size differs");
    chunks.push(chunk);
  }
  const data = new Uint8Array(Buffer.concat(chunks));
  if (size !== manifest.bytes || objectDigest(data) !== manifest.sha256)
    throw new Error("Session archive checksum differs");
  // This is an opaque, hash-verified native payload. Native import performs the
  // full pinned protocol validation; no home-grown conversation reconstruction.
  const native = JSON.parse(new TextDecoder().decode(data)) as SessionTransferData;
  if (
    native.info.id !== manifest.checkpoint.sessionID ||
    native.messages.at(-1)?.id !== manifest.checkpoint.throughMessageID
  )
    throw new Error("Session archive identity differs");
  return { manifest, native };
}

// Preparation only, not a public command or an authorization grant. The caller
// must own a fresh runtime and reconcile all uncertain product effects first.
// Import neither prompts nor restores credentials, environment or permissions.
export async function importNativeSessionArchive(client: Client, native: SessionTransferData) {
  const version = await client.server.info({ signal: AbortSignal.timeout(5_000) });
  if (version.version !== upstream.openCode.version)
    throw new Error("Session import requires the pinned OpenCode build");
  const info = { ...native.info };
  delete info.permissions;
  delete info.metadata;
  delete info.revert;
  delete info.parentID;
  delete info.fork;
  const location = { directory: "/workspace/project" };
  return client.session.import(
    { info: { ...info, location }, messages: native.messages, location },
    { signal: AbortSignal.timeout(30_000) },
  );
}

export function summarizeNativeSession(messages: SessionTransferData["messages"]) {
  const tools = new Map<
    string,
    { name: string; completed: number; failed: number; elapsedMS: number }
  >();
  let retries = 0;
  let cost = 0;
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  for (const message of messages) {
    if (message.type !== "assistant") continue;
    cost += message.cost ?? 0;
    if (message.tokens) {
      tokens.input += message.tokens.input;
      tokens.output += message.tokens.output;
      tokens.reasoning += message.tokens.reasoning;
      tokens.cacheRead += message.tokens.cache.read;
      tokens.cacheWrite += message.tokens.cache.write;
    }
    for (const part of message.content) {
      if (part.type !== "tool") continue;
      const name = part.name.slice(0, 200);
      const key = tools.has(name) || tools.size < 32 ? name : "other";
      const entry = tools.get(key) ?? { name: key, completed: 0, failed: 0, elapsedMS: 0 };
      if (part.state.status === "completed") entry.completed++;
      if (part.state.status === "error") entry.failed++;
      if (part.time.completed !== undefined)
        entry.elapsedMS += Math.max(0, part.time.completed - part.time.created);
      tools.set(key, entry);
    }
    retries += message.retry?.attempt ?? 0;
  }
  return { messages: messages.length, tools: [...tools.values()], retries, cost, tokens };
}
