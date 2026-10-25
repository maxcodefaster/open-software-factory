import { expect, test } from "bun:test";
import { decodeResponse } from "@solidjs/web/server-functions/client";
import { createDeliveryService } from "../../apps/factory/src/delivery/service";
import { CommandError } from "../../apps/factory/src/command-error";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { compiledFactoryEndpoint, factoryFunctionRequest } from "../fixtures/server-functions";

test("native Delivery preserves exact review/Stop identities, current authority and admitted work after disconnect", async () => {
  const origin = "https://owned-delivery.test",
    actor = crypto.randomUUID(),
    change = crypto.randomUUID(),
    project = crypto.randomUUID(),
    review = crypto.randomUUID(),
    verification = crypto.randomUUID(),
    stop = crypto.randomUUID(),
    date = new Date("2026-10-25T00:00:00Z");
  let maintenance = true,
    allowed = true,
    developer = true,
    authenticated = true;
  const effects: unknown[][] = [],
    admitted = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const value = () => ({
    reviewId: review,
    verificationId: verification,
    checksStopId: stop,
    approvedAt: date,
  });
  const service = createDeliveryService({
    access: {
      async requireChange(userID, changeID) {
        expect([userID, changeID]).toEqual([actor, change]);
        if (!allowed) throw new CommandError("not-found", "Change not found");
        return project;
      },
      async requireDevelopment(userID, projectID) {
        expect([userID, projectID]).toEqual([actor, project]);
        if (!developer) throw new CommandError("forbidden", "Developer access required");
      },
    },
    controller: {
      async get(...args) {
        effects.push(["get", ...args]);
        return value();
      },
      async approve(...args) {
        effects.push(["approve", ...args]);
        admitted.resolve();
        await release.promise;
        return value();
      },
      async retryReview(...args) {
        effects.push(["retry-review", ...args]);
        return value();
      },
      async resumeChecks(...args) {
        effects.push(["resume-checks", ...args]);
        return value();
      },
    },
  });
  const endpoint = await compiledFactoryEndpoint({
    origin,
    session: async () => (authenticated ? { user: { id: actor } } : null),
    maintenance: async () => maintenance,
    requireFresh: async () => {},
    services: { delivery: service } as unknown as FactoryServices,
  });
  const call = async (name: string, args: unknown[]) =>
    decodeResponse(await endpoint(await factoryFunctionRequest(origin, name, args)));
  const retry = { commandId: crypto.randomUUID(), reviewId: review },
    resume = { commandId: crypto.randomUUID(), verificationId: verification, stopId: stop };
  for (const [name, args] of [
    ["approveDelivery", [change]],
    ["retryCandidateReview", [change, retry]],
    ["resumeVerification", [change, resume]],
  ] as Array<[string, unknown[]]>)
    expect(await call(name, args)).toMatchObject({ ok: false, status: 503 });
  expect(effects).toEqual([]);
  maintenance = false;
  for (const [name, args] of [
    ["getDelivery", ["not-an-id"]],
    ["approveDelivery", ["not-an-id"]],
    ["retryCandidateReview", [change, { ...retry, createdBy: actor }]],
    ["resumeVerification", [change, { ...resume, stopId: "unconfirmed" }]],
  ] as Array<[string, unknown[]]>)
    expect(await call(name, args)).toMatchObject({ ok: false, status: 400 });
  expect(effects).toEqual([]);
  allowed = false;
  expect(await call("getDelivery", [change])).toMatchObject({ ok: false, status: 404 });
  allowed = true;
  developer = false;
  expect(await call("approveDelivery", [change])).toMatchObject({ ok: false, status: 403 });
  // A Contributor may explicitly retry an incomplete independent review. Only
  // its exact controller admission decides eligibility, never a transport role.
  expect(await call("retryCandidateReview", [change, retry])).toMatchObject({ ok: true });
  developer = true;
  expect(await call("getDelivery", [change])).toMatchObject({
    ok: true,
    value: { approvedAt: date.toISOString() },
  });
  expect(await call("resumeVerification", [change, resume])).toMatchObject({ ok: true });
  expect(effects).toEqual([
    ["retry-review", change, actor, retry.commandId, review],
    ["get", change],
    ["resume-checks", change, actor, resume.commandId, verification, stop],
  ]);
  const cancellation = new AbortController();
  const pending = endpoint(
    await factoryFunctionRequest(origin, "approveDelivery", [change], {}, cancellation.signal),
  );
  void pending.catch(() => {});
  await admitted.promise;
  cancellation.abort();
  release.resolve();
  await pending.catch(() => undefined);
  expect(effects.filter(([kind]) => kind === "approve")).toEqual([["approve", change, actor]]);
  authenticated = false;
  expect(
    (await endpoint(await factoryFunctionRequest(origin, "getDelivery", [change]))).status,
  ).toBe(401);
});
