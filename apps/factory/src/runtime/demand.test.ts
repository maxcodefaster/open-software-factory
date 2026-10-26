import { expect, test } from "bun:test";
import { createRuntimeDemand, runtimeDocumentRequest } from "./demand";

test("App navigation is demand, not background reads or socket reconnects", () => {
  expect(runtimeDocumentRequest(new Request("https://app/events"))).toBe(false);
  expect(
    runtimeDocumentRequest(
      new Request("https://app/", { headers: { "sec-fetch-mode": "navigate" } }),
    ),
  ).toBe(true);
  expect(
    runtimeDocumentRequest(
      new Request("https://app/", { method: "POST", headers: { "sec-fetch-mode": "navigate" } }),
    ),
  ).toBe(false);
});

test("App demand resumes exactly the original Attempt once and waits for readiness", async () => {
  let state = "paused",
    resumes = 0,
    time = 0,
    uses = 0;
  const demand = createRuntimeDemand(
    {
      get: async () => ({ state, failure: null }),
      async resumeForApp(attemptID, userID, deadline) {
        expect(attemptID).toBe("original");
        expect(userID).toBe("authorized-viewer");
        expect(deadline).toBe(420_000);
        resumes++;
        state = "starting";
      },
    },
    {
      use() {
        uses++;
        return true;
      },
    },
    async (ms) => {
      time += ms;
      state = "ready";
    },
    () => time,
  );
  expect(await demand("original", "authorized-viewer")).toBe(true);
  expect(resumes).toBe(1);
  expect(uses).toBe(1);
});

test("App demand never replaces stopped or failed execution and never loops an unconfirmed resume", async () => {
  for (const initial of ["stopped", "failed", "paused"]) {
    let state = initial,
      resumes = 0;
    const demand = createRuntimeDemand(
      {
        get: async () => ({ state, failure: state === "failed" ? "Retained failure" : null }),
        async resumeForApp() {
          resumes++;
          state = "failed";
        },
      },
      { use: () => false },
    );
    expect(await demand("original", "viewer")).toBe(false);
    expect(resumes).toBe(initial === "paused" ? 1 : 0);
  }
});
