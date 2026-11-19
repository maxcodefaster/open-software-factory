import { expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createBootstrapService } from "./service";

test("Bootstrap projects only public session fields and reads private preferences only for the request's user", async () => {
  const preference = mock(async () => ({ desktopBackgroundKey: "river-landscape" as const }));
  const availability = mock(async () => true);
  const service = createBootstrapService({
    preference,
    policy: () => ({ companySignIn: false, sessionDays: 7 }),
    planningCacheURL: "http://127.0.0.1:4948",
    signingKey: "owned-installation-signing-key",
    forgeOrigins: { browser: "https://forge.test", transport: "http://forge.internal" },
    modelAvailability: availability,
  });
  expect((await service.get(null)).session).toBeNull();
  expect(preference).not.toHaveBeenCalled();
  const result = await service.get({
    user: {
      id: "request-user",
      name: "Owned",
      email: "owned@fixture.test",
      privateField: "hidden",
    },
    session: { token: "private-session-token", id: "native-session" },
    systemManager: true,
  });
  expect(result.session).toEqual({
    user: { id: "request-user", name: "Owned", email: "owned@fixture.test" },
    systemManager: true,
  });
  expect(JSON.stringify(result)).not.toContain("private-session-token");
  expect(JSON.stringify(result)).not.toContain("privateField");
  expect(preference).toHaveBeenCalledWith("request-user");
  expect(availability).toHaveBeenCalledTimes(2);
});

test("offline planning is scoped to the retained installation key, not its origin or administrator", async () => {
  const options = {
    preference: async () => ({ desktopBackgroundKey: "river-landscape" as const }),
    policy: () => ({ companySignIn: false, sessionDays: 7 }),
    planningCacheURL: "https://factory.test/planning",
    forgeOrigins: { browser: "https://forge.test", transport: "http://forge.internal" },
    modelAvailability: async () => false,
    signingKey: "owned-first-installation-signing-key",
  };
  const first = await createBootstrapService(options).get(null);
  const restarted = await createBootstrapService(options).get(null);
  const replacement = await createBootstrapService({
    ...options,
    signingKey: "owned-new-installation-signing-key",
  }).get(null);
  expect(first.planningCacheScope).toMatch(/^[a-f0-9]{64}$/);
  expect(first.planningCacheScope).toBe(
    createHmac("sha256", options.signingKey).update("factory-planning-cache-v1").digest("hex"),
  );
  expect(restarted.planningCacheScope).toBe(first.planningCacheScope);
  expect(replacement.planningCacheScope).not.toBe(first.planningCacheScope);
  expect(JSON.stringify(first)).not.toContain(options.signingKey);
});

test("a restored deployment gets a distinct offline replica while retaining its signing key", async () => {
  const options = {
    preference: async () => ({ desktopBackgroundKey: "river-landscape" as const }),
    policy: () => ({ companySignIn: false, sessionDays: 7 }),
    planningCacheURL: "https://factory.test/planning",
    forgeOrigins: { browser: "https://forge.test", transport: "http://forge.internal" },
    modelAvailability: async () => false,
    signingKey: "retained-installation-signing-key",
    planningCacheEpoch: "owned-source-deployment-epoch",
  };
  const source = await createBootstrapService(options).get(null);
  const restarted = await createBootstrapService(options).get(null);
  const restoredEpoch = "owned-restored-deployment-epoch";
  const restored = await createBootstrapService({
    ...options,
    planningCacheEpoch: restoredEpoch,
  }).get(null);
  const differentKey = await createBootstrapService({
    ...options,
    signingKey: "different-installation-signing-key",
  }).get(null);

  expect(source.planningCacheScope).toMatch(/^[a-f0-9]{64}$/);
  expect(restarted.planningCacheScope).toBe(source.planningCacheScope);
  expect(restored.planningCacheScope).not.toBe(source.planningCacheScope);
  expect(differentKey.planningCacheScope).not.toBe(source.planningCacheScope);
  expect(restored).toEqual({ ...source, planningCacheScope: restored.planningCacheScope });
  expect(JSON.stringify(source)).not.toContain(options.signingKey);
  expect(JSON.stringify(source)).not.toContain(options.planningCacheEpoch);
  expect(JSON.stringify(restored)).not.toContain(restoredEpoch);
});

test("planning cache epochs are opaque and a supplied empty epoch differs from absence", async () => {
  const options = {
    preference: async () => ({ desktopBackgroundKey: "river-landscape" as const }),
    policy: () => ({ companySignIn: false, sessionDays: 7 }),
    planningCacheURL: "https://factory.test/planning",
    forgeOrigins: { browser: "https://forge.test", transport: "http://forge.internal" },
    modelAvailability: async () => false,
    signingKey: "retained-installation-signing-key",
  };
  const epochs = [undefined, "", "epoch", " epoch", "epoch ", "epoch\0"];
  const scopes = await Promise.all(
    epochs.map(async (planningCacheEpoch) => {
      const result = await createBootstrapService(
        planningCacheEpoch === undefined ? options : { ...options, planningCacheEpoch },
      ).get(null);
      return result.planningCacheScope;
    }),
  );
  expect(new Set(scopes).size).toBe(epochs.length);
});
