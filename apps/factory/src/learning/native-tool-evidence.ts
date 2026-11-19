import { isDeepStrictEqual } from "node:util";
import { buildBrowserToolCatalogue } from "../../../../packages/conversation-domain/src/browser-tools";
import type { LearningCase } from "../../../../packages/conversation-domain/src/learning";
import { readNativeSessionArchive } from "../agent/session-archive";
import { objectDigest, type PrivateObjects } from "../storage/objects";

export const nativeToolEvidenceMaximumBytes = 4_000;
export type SavedNativeToolArchive = {
  turnID: string;
  runtimeAttemptID: string;
  sessionID: string;
  promptID: string;
  throughMessageID: string;
  source: Record<string, unknown>;
  key: string;
  sha256: string;
  producerVersion: string;
};
type Evidence = LearningCase["evidence"][number];
const limits = { messages: 256, parts: 2_048, commandCharacters: 4_096 };
const archiveLimits = {
  bytes: 2 * 1024 ** 2,
  chunks: 2,
  manifestBytes: 64 * 1024,
  deadlineMS: 5_000,
};
const toolNames = new Set([
  "shell",
  "bash",
  "read",
  "write",
  "edit",
  "patch",
  "glob",
  "grep",
  "list",
  "webfetch",
  "websearch",
  "task",
  "skill",
]);
const browserTools = new Set<string>(
  buildBrowserToolCatalogue.map(({ name }) => `factory_browser_${name}`),
);
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function hash(value: unknown) {
  return objectDigest(new TextEncoder().encode(JSON.stringify(value)));
}
class ArchiveReadLimit extends Error {
  constructor(readonly reason: "archive-size-limit" | "archive-time-limit") {
    super(reason);
  }
}
function boundedArchiveObjects(objects: PrivateObjects) {
  const abort = new AbortController();
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const cancel = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    void reader.cancel().catch(() => {});
  };
  abort.signal.addEventListener("abort", () => {
    for (const reader of readers) cancel(reader);
  });
  const timer = setTimeout(() => abort.abort(), archiveLimits.deadlineMS);
  let reads = 0;
  let payloadBytes = 0;
  async function withinDeadline<T>(promise: Promise<T>) {
    if (abort.signal.aborted) throw new ArchiveReadLimit("archive-time-limit");
    return new Promise<T>((resolve, reject) => {
      const expired = () => reject(new ArchiveReadLimit("archive-time-limit"));
      abort.signal.addEventListener("abort", expired, { once: true });
      promise.then(
        (value) => {
          abort.signal.removeEventListener("abort", expired);
          resolve(value);
        },
        (cause: unknown) => {
          abort.signal.removeEventListener("abort", expired);
          reject(cause);
        },
      );
    });
  }
  return {
    close() {
      clearTimeout(timer);
      abort.abort();
    },
    objects: {
      ...objects,
      async read(key: string) {
        if (abort.signal.aborted) throw new ArchiveReadLimit("archive-time-limit");
        const manifest = ++reads === 1;
        if (reads > archiveLimits.chunks + 1) throw new ArchiveReadLimit("archive-size-limit");
        // Stream rather than calling read(), whose storage bound is 125 MiB.
        // The adapter bounds connection establishment at 30s and has no caller
        // abort input. Cancel late headers immediately after our deadline; never
        // continue downloading or begin another object after that deadline.
        const opened = objects.open(key).then((response) => {
          if (abort.signal.aborted) {
            void response.body?.cancel().catch(() => {});
            throw new ArchiveReadLimit("archive-time-limit");
          }
          return response;
        });
        const response = await withinDeadline(opened);
        const maximum = manifest
          ? archiveLimits.manifestBytes
          : Math.min(1024 ** 2, archiveLimits.bytes - payloadBytes);
        const declared = response.headers.get("content-length");
        if (declared !== null && Number(declared) > maximum) {
          void response.body?.cancel().catch(() => {});
          throw new ArchiveReadLimit("archive-size-limit");
        }
        if (!response.ok || !response.body) {
          void response.body?.cancel().catch(() => {});
          throw new Error("Saved archive object is unavailable");
        }
        const reader = response.body.getReader();
        readers.add(reader);
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const chunk = await withinDeadline(reader.read());
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maximum) throw new ArchiveReadLimit("archive-size-limit");
            chunks.push(chunk.value);
          }
        } finally {
          readers.delete(reader);
          cancel(reader);
          reader.releaseLock();
        }
        const bytes = new Uint8Array(Buffer.concat(chunks));
        if (manifest) {
          const value = record(JSON.parse(new TextDecoder().decode(bytes)));
          if (
            (typeof value["bytes"] === "number" && value["bytes"] > archiveLimits.bytes) ||
            (Array.isArray(value["chunks"]) && value["chunks"].length > archiveLimits.chunks)
          )
            throw new ArchiveReadLimit("archive-size-limit");
        } else payloadBytes += bytes.byteLength;
        return bytes;
      },
    },
  };
}
function discovery(command: string) {
  // Deliberately recognize only a leading executable, not quoted prose or an
  // arbitrary shell program. These are method hints, not an execution audit.
  const executable = command.match(
    /^\s*(?:\/(?:usr\/)?s?bin\/)?(ss|netstat|lsof|ps|pgrep)(?=\s|$)/,
  )?.[1];
  if (executable === "ps" || executable === "pgrep") return "process-discovery";
  if (
    executable === "ss" ||
    executable === "netstat" ||
    (executable === "lsof" && /\s-[a-zA-Z]*i(?:TCP|UDP|\b)/.test(command))
  )
    return "port-discovery";
  return null;
}

// The caller must pass Learning's current privacy, policy and Developer gates
// before reading private objects. There is intentionally no native client here.
export async function readNativeToolEvidence(
  turnID: string,
  saved: SavedNativeToolArchive | undefined,
  objects: PrivateObjects,
): Promise<Evidence> {
  const id = `turn:${turnID}:native-tools`;
  const unknown = (reason: string): Evidence => ({
    id,
    kind: "configuration",
    body: JSON.stringify({ version: 1, status: "unknown", reason }),
    truncated: false,
  });
  if (!saved) return unknown("no-saved-checkpoint");
  const bounded = boundedArchiveObjects(objects);
  try {
    const { manifest, native } = await readNativeSessionArchive(
      bounded.objects,
      saved.key,
      saved.sha256,
    );
    if (
      saved.turnID !== turnID ||
      manifest.producer.version !== saved.producerVersion ||
      !isDeepStrictEqual(manifest.checkpoint, {
        turnID,
        runtimeAttemptID: saved.runtimeAttemptID,
        sessionID: saved.sessionID,
        promptID: saved.promptID,
        throughMessageID: saved.throughMessageID,
      }) ||
      !isDeepStrictEqual(manifest.source, saved.source)
    )
      return unknown("saved-checkpoint-unavailable");
    const messages: unknown[] = native.messages;
    const start = messages.findIndex((message) => record(message)["id"] === saved.promptID);
    if (start < 0 || record(messages[start])["type"] !== "user")
      return unknown("saved-checkpoint-unavailable");
    const turn = messages.slice(start + 1);
    if (
      turn.some((message) => record(message)["type"] === "user") ||
      !turn.some((message) => {
        const value = record(message);
        const completed = record(value["time"])["completed"];
        return (
          value["type"] === "assistant" &&
          value["finish"] === "stop" &&
          typeof completed === "number" &&
          Number.isFinite(completed)
        );
      })
    )
      return unknown("saved-checkpoint-unavailable");
    const tools = new Map<
      string,
      {
        tool: string;
        calls: number;
        completed: number;
        failed: number;
        unknown: number;
        timed: number;
        elapsedMS: number;
      }
    >();
    const methods = new Map<string, number>();
    const coverage = {
      earlierMessagesExcluded: start,
      turnMessages: turn.length,
      inspectedMessages: 0,
      inspectedParts: 0,
      omittedMessages: Math.max(0, turn.length - limits.messages),
      omittedParts: 0,
      unclassifiedMessages: 0,
      unclassifiedParts: 0,
      toolCalls: 0,
      unclassifiedToolCalls: 0,
      shellCalls: 0,
      classifiedShellCalls: 0,
      oversizedShellInputs: 0,
      limits: { ...limits, archive: archiveLimits },
    };
    for (const message of turn.slice(0, limits.messages)) {
      coverage.inspectedMessages++;
      const value = record(message);
      if (value["type"] !== "assistant" || !Array.isArray(value["content"])) {
        coverage.unclassifiedMessages++;
        continue;
      }
      const content = value["content"];
      const take = Math.min(content.length, limits.parts - coverage.inspectedParts);
      coverage.omittedParts += content.length - take;
      for (const raw of content.slice(0, take)) {
        coverage.inspectedParts++;
        const part = record(raw);
        if (typeof part["type"] !== "string") {
          coverage.unclassifiedParts++;
          continue;
        }
        if (part["type"] !== "tool") continue;
        const name = part["name"];
        const tool =
          typeof name === "string" && toolNames.has(name)
            ? name
            : typeof name === "string" && browserTools.has(name)
              ? "browser"
              : "other";
        const entry = tools.get(tool) ?? {
          tool,
          calls: 0,
          completed: 0,
          failed: 0,
          unknown: 0,
          timed: 0,
          elapsedMS: 0,
        };
        tools.set(tool, entry);
        coverage.toolCalls++;
        if (tool === "other") coverage.unclassifiedToolCalls++;
        entry.calls++;
        const state = record(part["state"]);
        const status = state["status"];
        if (status === "completed") entry.completed++;
        else if (status === "error") entry.failed++;
        else entry.unknown++;
        const time = record(part["time"]);
        const created = time["created"],
          completed = time["completed"];
        if (
          (status === "completed" || status === "error") &&
          typeof created === "number" &&
          typeof completed === "number" &&
          Number.isSafeInteger(created) &&
          Number.isSafeInteger(completed) &&
          created >= 0 &&
          completed >= created &&
          Number.isSafeInteger(entry.elapsedMS + (completed - created))
        ) {
          entry.timed++;
          entry.elapsedMS += completed - created;
        }
        if (tool === "shell" || tool === "bash") {
          coverage.shellCalls++;
          if (status !== "completed" && status !== "error") continue;
          const command = record(state["input"])["command"];
          if (typeof command !== "string") continue;
          if (command.length > limits.commandCharacters) {
            coverage.oversizedShellInputs++;
            continue;
          }
          const category = discovery(command);
          if (category) {
            coverage.classifiedShellCalls++;
            methods.set(category, (methods.get(category) ?? 0) + 1);
          }
        }
      }
    }
    const truncated =
      coverage.omittedMessages > 0 ||
      coverage.omittedParts > 0 ||
      coverage.unclassifiedMessages > 0 ||
      coverage.unclassifiedParts > 0 ||
      coverage.oversizedShellInputs > 0;
    const body = JSON.stringify({
      version: 1,
      status: "observed",
      provenance: {
        turnID,
        runtimeAttemptID: saved.runtimeAttemptID,
        manifestSHA256: saved.sha256,
        payloadSHA256: manifest.sha256,
        checkpointSHA256: hash(manifest.checkpoint),
        sourceSHA256: hash(manifest.source),
      },
      tools: [...tools.values()]
        .sort((a, b) => a.tool.localeCompare(b.tool))
        .map((entry) => ({
          ...entry,
          elapsedMS: entry.timed ? entry.elapsedMS : null,
        })),
      methods: [...methods]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, calls]) => ({
          category,
          calls,
          repeated: calls > 1,
        })),
      coverage,
      limitations:
        "This saved turn's assistant tool parts only, not child Sessions, external effects or correctness. Failures are native error states. Timings are recorded created-to-completed milliseconds, including waits; summed tool times are not wall time. Discovery categories are leading-executable hints, not shell interpretation. Arguments, outputs, URLs, paths and transcript text are withheld. Source references identify the last confirmed generation, not turn-atomic Source.",
    });
    if (Buffer.byteLength(body) > nativeToolEvidenceMaximumBytes)
      return unknown("projection-exceeds-bound");
    return { id, kind: "artifact", body, truncated };
  } catch (cause) {
    // Archive/object errors can contain private text and signed URLs.
    if (cause instanceof ArchiveReadLimit) return unknown(cause.reason);
    return unknown("saved-checkpoint-unavailable");
  } finally {
    bounded.close();
  }
}
