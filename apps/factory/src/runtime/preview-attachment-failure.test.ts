import { expect, test } from "bun:test";
import { previewAttachmentFailure } from "./preview-attachment-failure";

const origin = "https://factory.example";
const path = `/runtime/01994a7d-0000-7000-8000-000000000001/preview/app/`;

test("attachment failure preserves failure status and exposes no private protocol diagnostics", async () => {
  const request = new Request(`${origin}${path}`, {
    headers: { "sec-fetch-mode": "navigate" },
  });
  const result = previewAttachmentFailure(
    request,
    origin,
    Response.json({ error: "private runtime diagnostics" }, { status: 503 }),
  );
  expect(result.status).toBe(503);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(result.headers.get("content-security-policy")).not.toContain("unsafe-inline");
  expect(result.headers.get("content-security-policy")).toContain(
    `frame-ancestors 'self' ${origin}`,
  );
  const body = await result.text();
  expect(body).toContain("factory-preview-document-failed");
  expect(body).not.toContain("private runtime diagnostics");
});

test("ordinary JSON calls, IDE navigation, App mutations and success keep their original response", () => {
  for (const [pathname, method, navigation, status] of [
    [path, "GET", false, 500],
    ["/api/project", "GET", true, 500],
    [path.replace("/preview/app/", "/ide/"), "GET", true, 500],
    [path, "POST", true, 500],
    [path, "GET", true, 200],
  ] as const) {
    const request = new Request(`${origin}${pathname}`, {
      method,
      ...(navigation ? { headers: { "sec-fetch-mode": "navigate" } } : {}),
    });
    const response = Response.json({ retained: true }, { status });
    expect(previewAttachmentFailure(request, origin, response)).toBe(response);
  }
});
