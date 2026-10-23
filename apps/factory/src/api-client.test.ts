import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { apiRequest, apiUpload } from "./api-client";

test("shows a readable recovery error for an invalid successful response", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
  try {
    await expect(apiRequest(z.object({ id: z.string() }), "/fixture")).rejects.toThrow(
      "Factory returned an unexpected response. Retry, or reload Factory if this continues.",
    );
  } finally {
    fetch.mockRestore();
  }
});

test("retains the server's command error and returns validated successful data", async () => {
  const fetch = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ error: "Revision is immutable" }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ id: "revision" }));
  try {
    const schema = z.object({ id: z.string() });
    await expect(apiRequest(schema, "/fixture")).rejects.toMatchObject({
      message: "Revision is immutable",
      status: 409,
    });
    await expect(apiRequest(schema, "/fixture")).resolves.toEqual({ id: "revision" });
  } finally {
    fetch.mockRestore();
  }
});

function uploadFixture() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");
  const requests: RequestFixture[] = [];
  class RequestFixture {
    method = "";
    path = "";
    headers: Record<string, string> = {};
    body: ArrayBuffer | undefined;
    status = 0;
    responseText = "";
    upload: {
      onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void;
      onload?: () => void;
    } = {};
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    ontimeout?: () => void;
    constructor() {
      requests.push(this);
    }
    open(method: string, path: string) {
      this.method = method;
      this.path = path;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    send(body: ArrayBuffer) {
      this.body = body;
    }
    complete(status: number, value: unknown) {
      this.status = status;
      this.responseText = JSON.stringify(value);
      this.onload?.();
    }
  }
  Object.defineProperty(globalThis, "XMLHttpRequest", {
    configurable: true,
    value: RequestFixture,
  });
  return {
    requests,
    restore() {
      if (original) Object.defineProperty(globalThis, "XMLHttpRequest", original);
      else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
    },
  };
}

test("measured upload progress and transferred bytes do not acknowledge server processing", async () => {
  const fixture = uploadFixture();
  try {
    const progress: number[][] = [];
    let transferred = false;
    let settled = false;
    const body = new ArrayBuffer(4);
    const promise = apiUpload(z.object({ id: z.string() }), "/api/attachments/owned", {
      body,
      mediaType: "text/plain",
      onProgress: (loaded, total) => progress.push([loaded, total]),
      onTransferred: () => {
        transferred = true;
      },
    }).then((value) => {
      settled = true;
      return value;
    });
    const request = fixture.requests[0]!;
    expect(request.method).toBe("PUT");
    expect(request.path).toBe("/api/attachments/owned");
    expect(request.headers).toEqual({ "content-type": "text/plain" });
    expect(request.body).toBe(body);
    request.upload.onprogress?.({ lengthComputable: false, loaded: 2, total: 0 });
    request.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 4 });
    expect(progress).toEqual([[2, 4]]);
    request.upload.onload?.();
    await Promise.resolve();
    expect(transferred).toBe(true);
    expect(settled).toBe(false);
    request.complete(200, { id: "owned" });
    await expect(promise).resolves.toEqual({ id: "owned" });
  } finally {
    fixture.restore();
  }
});

test("upload failures preserve command errors and never retry or claim readiness", async () => {
  const fixture = uploadFixture();
  try {
    const promise = apiUpload(z.object({ id: z.string() }), "/api/attachments/owned", {
      body: new ArrayBuffer(0),
      mediaType: "text/plain",
      onProgress() {},
      onTransferred() {},
    });
    fixture.requests[0]!.complete(409, { error: "Upload identity changed" });
    await expect(promise).rejects.toMatchObject({
      status: 409,
      message: "Upload identity changed",
    });
    expect(fixture.requests).toHaveLength(1);
  } finally {
    fixture.restore();
  }
});

test("lost upload confirmation and malformed success both require explicit recovery", async () => {
  const fixture = uploadFixture();
  try {
    for (const outcome of ["network", "invalid"] as const) {
      const promise = apiUpload(z.object({ id: z.string() }), "/api/attachments/owned", {
        body: new ArrayBuffer(0),
        mediaType: "text/plain",
        onProgress() {},
        onTransferred() {},
      });
      const request = fixture.requests.at(-1)!;
      if (outcome === "network") request.onerror?.();
      else request.complete(200, {});
      await expect(promise).rejects.toThrow(
        outcome === "network"
          ? "Upload confirmation was lost. Retry the same file request."
          : "Factory returned an unexpected response.",
      );
    }
    expect(fixture.requests).toHaveLength(2);
  } finally {
    fixture.restore();
  }
});
