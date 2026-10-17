import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { apiRequest } from "./api-client";

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
