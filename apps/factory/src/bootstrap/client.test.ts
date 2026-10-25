import { expect, test } from "bun:test";
import { browserBootstrap } from "./client";
import type { Bootstrap } from "../api-contracts";

test("only development rewrites planning transport locally, without rewriting the native function wire format", () => {
  const input: Bootstrap = {
    session: null,
    identity: { companySignIn: false, sessionDays: 7 },
    uiPreference: { desktopBackgroundKey: "river-landscape" },
    zeroCacheURL: "http://127.0.0.1:4948/planning/",
    modelRelayConfigured: false,
  };
  expect(browserBootstrap(input, false, "https://factory.test")).toBe(input);
  expect(browserBootstrap(input, true, "http://127.0.0.1:5173").zeroCacheURL).toBe(
    "http://127.0.0.1:5173/__factory_zero/planning",
  );
  expect(input.zeroCacheURL).toBe("http://127.0.0.1:4948/planning/");
});
