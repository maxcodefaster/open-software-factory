import { expect, test } from "bun:test";
import { readVerificationDiagnostic } from "./diagnostic-output";

const credential = "owned-credential-only-for-diagnostic-test";
function streamed(text: string) {
  const bytes = Buffer.from(text);
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + 13));
        offset += 13;
      },
    }),
    {
      status: 206,
      headers: { "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}` },
    },
  );
}

test("streamed diagnosis preserves native byte offsets across UTF-8 and redaction", async () => {
  const prefix = `2026-10-31T02:25:23Z ✔ Größe preserved API_KEY=${credential}\n`.repeat(100);
  const failure =
    "2026-10-31T02:27:01Z AssertionError: actual HTTP status 502, expected 200\n" +
    "2026-10-31T02:27:01Z -----BEGIN PRIVATE KEY-----\n" +
    "private-key-material-never-shared\n" +
    "-----END PRIVATE KEY-----\n" +
    `2026-10-31T02:27:01Z Authorization: Bearer ${credential}\n`;
  const raw = prefix + failure + "✔ unrelated checks passed\n".repeat(500);
  const output = await readVerificationDiagnostic(streamed(raw), credential);
  expect(output).toContain("actual HTTP status 502, expected 200");
  const offset = Number(output.match(/native byte (\d+)/)?.[1]);
  expect(offset).toBeGreaterThan(0);
  expect(
    Buffer.from(raw)
      .subarray(offset, offset + 4096)
      .toString(),
  ).toContain("AssertionError");
  expect(output.length).toBeLessThanOrEqual(2400);
  for (const secret of [credential, "private-key-material-never-shared"])
    expect(output).not.toContain(secret);
});

test("overlong lines are omitted without retaining their contents or shifting the native cursor", async () => {
  const oversized = `API_KEY=${credential}${"x".repeat(70_000)}\n`;
  const output = await readVerificationDiagnostic(
    streamed(`${oversized}AssertionError: source fixture missing\n${"✔ passed\n".repeat(500)}`),
    credential,
  );
  expect(output).toContain("source fixture missing");
  expect(output).toContain("[Overlong native log line omitted]");
  expect(output).not.toContain(credential);
  expect(output).not.toContain("x".repeat(100));
});

test("a large unrecognized log remains an explicit context request, not an invented diagnosis", async () => {
  const output = await readVerificationDiagnostic(
    streamed("ordinary progress\n".repeat(2000)),
    credential,
  );
  expect(output).toContain("No failure marker found");
  expect(output.length).toBeLessThanOrEqual(2400);
});

test("incomplete or nonzero-origin native ranges are rejected and released", async () => {
  for (const range of ["bytes 0-499/1000", "bytes 500-999/1000", "invalid"]) {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 206, headers: { "content-range": range } },
    );
    await expect(readVerificationDiagnostic(response, credential)).rejects.toThrow(
      "complete native stream",
    );
    expect(cancelled).toBe(true);
  }
});

test("truncated bodies and interrupted streams never become an accepted excerpt", async () => {
  await expect(
    readVerificationDiagnostic(
      new Response("AssertionError: incomplete", {
        status: 206,
        headers: { "content-range": "bytes 0-999/1000" },
      }),
      credential,
    ),
  ).rejects.toThrow("incomplete");
  await expect(
    readVerificationDiagnostic(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("Native log transport interrupted"));
          },
        }),
      ),
      credential,
    ),
  ).rejects.toThrow("transport interrupted");
});
