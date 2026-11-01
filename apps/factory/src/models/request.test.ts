import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRequestError, readModelRequest } from "./request";

test.each([
  [
    '{"model":"owned","reasoning":{"effort":"medium"},"input":[{"type":"message","reasoning":{"effort":"low"}}]}',
    true,
  ],
  [
    '{"reasoning":{"effort":"medium"},"input":[{"reasoning":{"effort":"medium"},"type":"configuration_update"}],"model":"owned"}',
    true,
  ],
  [
    '{"model":"owned","reasoning":{"effort":"medium"},"input":[{"reasoning":{"effort":"low"},"type":"configuration_update"}]}',
    false,
  ],
  [
    '{"model":"owned","reasoning":{"effort":"medium"},"input":[{"type":"configuration_update","reasoning":null}]}',
    false,
  ],
  [
    '{"model":"owned","reasoning":{"effort":"medium"},"input":[{"type":"configuration_update"}]}',
    false,
  ],
  ['{"model":"owned","reasoning":{"effort":null}}', false],
  ['{"model":"owned","reasoning":"medium"}', false],
  [
    '{"model":"owned","reasoning":{"effort":"medium"},"input":{"type":"configuration_update","reasoning":{"effort":"low"}}}',
    true,
  ],
] as const)("streamed model controls retain native semantics: %s", async (body, reasoningValid) => {
  const root = await mkdtemp(join(tmpdir(), "owned-model-request-"));
  try {
    const bytes = new TextEncoder().encode(body);
    let index = 0;
    const request = new Request("http://owned.invalid", {
      method: "POST",
      body: new ReadableStream({
        pull(controller) {
          if (index === bytes.byteLength) controller.close();
          else controller.enqueue(bytes.subarray(index, ++index));
        },
      }),
    });
    const result = await readModelRequest(request, "medium", { temporaryRoot: root });
    try {
      expect(result.model).toBe("owned");
      expect(result.reasoningValid).toBe(reasoningValid);
      expect(await result.body.text()).toBe(body);
      const [directory] = await readdir(root);
      if (!directory) throw new Error("Owned spool missing");
      expect((await stat(join(root, directory))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, directory, "request.json"))).mode & 0o777).toBe(0o600);
    } finally {
      await result.dispose();
    }
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  '{"model":"other","model":"owned","reasoning":{"effort":"medium"}}',
  '{"model":"owned","reasoning":{"effort":"low","effort":"medium"}}',
  '{"model":"owned","input":[],"input":[{"type":"configuration_update","reasoning":{"effort":"low"}}]}',
  '{"model":"owned","input":[{"type":"message","type":"configuration_update"}]}',
  '{"model":"owned","input":[{"type":"configuration_update","reasoning":{"effort":"low","effort":"medium"}}]}',
  '{"model":"owned"} {}',
  '{"model":"owned"',
  "\uFEFF{}",
  "[",
])("invalid or ambiguous native JSON cannot be forwarded: %s", async (body) => {
  const root = await mkdtemp(join(tmpdir(), "owned-model-invalid-"));
  try {
    await expect(
      readModelRequest(
        new Request("http://owned.invalid", {
          method: "POST",
          body,
        }),
        "medium",
        { temporaryRoot: root },
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: "Invalid model request",
    });
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP byte accounting handles multibyte text, chunked overflow and cancellation without retaining input", async () => {
  const root = await mkdtemp(join(tmpdir(), "owned-model-overflow-"));
  try {
    const body = JSON.stringify({ model: "owned", content: "Übung 👋".repeat(8) });
    await expect(
      readModelRequest(
        new Request("http://owned.invalid", {
          method: "POST",
          body,
        }),
        "medium",
        { temporaryRoot: root, maximumBytes: body.length },
      ),
    ).rejects.toMatchObject({
      status: 413,
    });
    const abort = new AbortController();
    const started = Promise.withResolvers<void>();
    let cancelled = false;
    const request = new Request("http://owned.invalid", {
      method: "POST",
      signal: abort.signal,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"model":"owned"'));
          started.resolve();
        },
        cancel() {
          cancelled = true;
        },
      }),
    });
    const reading = readModelRequest(request, "medium", { temporaryRoot: root });
    await started.promise;
    abort.abort();
    await expect(reading).rejects.toBeInstanceOf(ModelRequestError);
    expect(cancelled).toBe(true);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed UTF-8, excessive JSON nesting and unavailable temporary storage never retain input", async () => {
  const root = await mkdtemp(join(tmpdir(), "owned-model-parser-"));
  try {
    for (const body of [
      new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
      `${"[".repeat(257)}0${"]".repeat(257)}`,
      `{"${"x".repeat(65_537)}":0}`,
    ]) {
      await expect(
        readModelRequest(
          new Request("http://owned.invalid", {
            method: "POST",
            body,
          }),
          "medium",
          { temporaryRoot: root },
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(await readdir(root)).toEqual([]);
    }
    let cancelled = false;
    await expect(
      readModelRequest(
        new Request("http://owned.invalid", {
          method: "POST",
          body: new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        }),
        "medium",
        { temporaryRoot: join(root, "unavailable") },
      ),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(cancelled).toBe(true);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
