import { expect, mock, test } from "bun:test";
import { createBootstrapService } from "./service";

test("Bootstrap projects only public session fields and reads private preferences only for the request's user", async () => {
  const preference = mock(async () => ({ desktopBackgroundKey: "river-landscape" as const }));
  const availability = mock(async () => true);
  const service = createBootstrapService({
    preference,
    policy: () => ({ companySignIn: false, sessionDays: 7 }),
    planningCacheURL: "http://127.0.0.1:4948",
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
