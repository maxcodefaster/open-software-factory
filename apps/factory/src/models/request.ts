import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import parser, { type Token } from "stream-json/parser.js";
import { maximumHTTPRequestBytes } from "../http";

export class ModelRequestError extends Error {
  constructor(
    readonly status: 400 | 413 | 503,
    message: string,
  ) {
    super(message);
    this.name = "ModelRequestError";
  }
}

type Scope = "root" | "reasoning" | "input" | "item" | "item-reasoning" | "other";
type Update = { type?: string; effort?: string; reasoning: boolean };
type Frame = {
  scope: Scope;
  key: string;
  seen: Set<string>;
  update?: Update;
};

// Inspect only execution-control fields. Screenshots, tool results and message
// strings pass through unchanged, without constructing their object tree.
function envelope(expectedReasoning: string | null) {
  const stack: Frame[] = [];
  let rootObject = false;
  let key = false;
  let text = "";
  let capture = false;
  let model: string | undefined;
  let effort: string | undefined;
  let changedReasoning = false;
  const invalid = () => {
    throw new ModelRequestError(400, "Invalid model request");
  };
  const controlled = (frame: Frame) =>
    frame.scope === "root"
      ? ["model", "reasoning", "input"].includes(frame.key)
      : frame.scope === "item"
        ? ["type", "reasoning"].includes(frame.key)
        : ["reasoning", "item-reasoning"].includes(frame.scope) && frame.key === "effort";
  return {
    token(token: Token) {
      const parent = stack.at(-1);
      switch (token.name) {
        case "startObject":
        case "startArray": {
          if (stack.length >= 256) invalid();
          const object = token.name === "startObject";
          let scope: Scope = "other";
          let update = parent?.update;
          if (!parent) {
            rootObject = object;
            scope = object ? "root" : "other";
          } else if (parent.scope === "root" && parent.key === "reasoning" && object)
            scope = "reasoning";
          else if (parent.scope === "root" && parent.key === "input" && !object) scope = "input";
          else if (parent.scope === "input" && object) {
            scope = "item";
            update = { reasoning: false };
          } else if (parent.scope === "item" && parent.key === "reasoning" && object) {
            scope = "item-reasoning";
            if (update) update.reasoning = true;
          }
          stack.push({ scope, key: "", seen: new Set(), ...(update ? { update } : {}) });
          break;
        }
        case "endObject":
        case "endArray": {
          const frame = stack.pop();
          if (frame?.scope === "item" && frame.update?.type === "configuration_update")
            changedReasoning ||=
              !frame.update.reasoning || frame.update.effort !== expectedReasoning;
          break;
        }
        case "startKey":
          key = true;
          text = "";
          break;
        case "endKey":
          if (!parent) return invalid();
          parent.key = text;
          if (controlled(parent)) {
            if (parent.seen.has(text)) invalid();
            parent.seen.add(text);
          }
          key = false;
          break;
        case "startString":
          text = "";
          capture = !!parent && controlled(parent);
          break;
        case "stringChunk":
          if (key) {
            if (text.length + token.value.length > 65_536) invalid();
            text += token.value;
          } else if (capture) {
            // Admitted model IDs and reasoning/type names are small. Discard
            // oversized control values, never a message or image.
            if (text.length + token.value.length > 256) {
              text = "";
              capture = false;
            } else text += token.value;
          }
          break;
        case "endString":
          if (capture && parent) {
            if (parent.scope === "root" && parent.key === "model") model = text;
            if (parent.scope === "reasoning" && parent.key === "effort") effort = text;
            if (parent.scope === "item" && parent.key === "type" && parent.update)
              parent.update.type = text;
            if (parent.scope === "item-reasoning" && parent.key === "effort" && parent.update)
              parent.update.effort = text;
          }
          capture = false;
          break;
      }
    },
    result: () => ({
      model: rootObject ? model : undefined,
      reasoningValid: effort === expectedReasoning && !changedReasoning,
    }),
  };
}

export async function readModelRequest(
  request: Request,
  expectedReasoning: string | null,
  options: { maximumBytes?: number; temporaryRoot?: string } = {},
) {
  const maximum = options.maximumBytes ?? maximumHTTPRequestBytes;
  const tooLarge = () => new ModelRequestError(413, "Model request exceeds HTTP ingress capacity");
  if (Number(request.headers.get("content-length")) > maximum) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new ModelRequestError(400, "Model request is required");
  let directory: string;
  try {
    directory = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), "factory-model-"));
  } catch {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    throw new ModelRequestError(503, "Model request storage is unavailable");
  }
  const path = join(directory, "request.json");
  const value = envelope(expectedReasoning);
  const tokenizer = parser.asStream({ packValues: false, streamValues: true, ignoreBOM: true });
  let parseFailure: unknown;
  tokenizer.on("data", (token: Token) => {
    try {
      value.token(token);
    } catch (cause) {
      parseFailure = cause;
      tokenizer.destroy(cause instanceof Error ? cause : undefined);
    }
  });
  tokenizer.on("error", (cause) => {
    parseFailure = cause;
  });
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  request.signal.addEventListener("abort", abort, { once: true });
  let bytes = 0;
  try {
    const file = await open(path, "wx", 0o600);
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const decode = (bytes?: Uint8Array) => {
        try {
          return decoder.decode(bytes, { stream: bytes !== undefined });
        } catch {
          throw new ModelRequestError(400, "Invalid model request");
        }
      };
      const parse = async (text: string) => {
        try {
          if (parseFailure) throw parseFailure;
          await new Promise<void>((resolve, reject) => {
            tokenizer.write(text, (cause) => (cause ? reject(cause) : resolve()));
          });
          if (parseFailure) throw parseFailure;
        } catch {
          throw new ModelRequestError(400, "Invalid model request");
        }
      };
      for (;;) {
        request.signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maximum) throw tooLarge();
        await file.writeFile(chunk.value);
        for (let offset = 0; offset < chunk.value.byteLength; offset += 65_536)
          await parse(decode(chunk.value.subarray(offset, offset + 65_536)));
      }
      request.signal.throwIfAborted();
      await parse(decode());
      await new Promise<void>((resolve, reject) => {
        tokenizer.end((cause?: Error | null) => (cause ? reject(cause) : resolve()));
      }).catch(() => {
        throw new ModelRequestError(400, "Invalid model request");
      });
      if (parseFailure) throw new ModelRequestError(400, "Invalid model request");
    } finally {
      await file.close();
    }
    return {
      ...value.result(),
      bytes,
      body: Bun.file(path),
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (cause) {
    await reader.cancel().catch(() => {});
    await rm(directory, { recursive: true, force: true });
    if (cause instanceof ModelRequestError) throw cause;
    if (request.signal.aborted) throw new ModelRequestError(400, "Model request was cancelled");
    throw new ModelRequestError(503, "Model request storage is unavailable");
  } finally {
    tokenizer.destroy();
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
