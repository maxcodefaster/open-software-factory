import { expect, test } from "bun:test";
import { browserLane, integrationLane } from "./lanes";
import playwright from "../../playwright.config";

test("explicit lanes keep paid calls and retained-installation restarts outside defaults", () => {
  expect(integrationLane("test/integration/project-environment.test.ts")).toBe("controllers");
  expect(integrationLane("test/integration/native-skill-loading.test.ts")).toBe("native");
  expect(integrationLane("test/integration/team-delivery.live.test.ts")).toBe("live");
  for (const name of ["change-agent", "change-recovery", "runtime-recovery", "ux-starter-capture"])
    expect(browserLane(`${name}.spec.ts`)).toBe("manual");
  expect(browserLane("agent-turn-live.spec.ts")).toBe("paid");
  expect(browserLane("project-agent.spec.ts")).toBe("paid");
  expect(browserLane("runtime-console.spec.ts")).toBe("native");
  expect(browserLane("skill-settings.spec.ts")).toBe("ui");
  expect(() => browserLane("unclassified.live.spec.ts")).toThrow("Unclassified");
});

test("the default browser selection excludes explicitly paid cases in mixed journey files", () => {
  const filter = playwright.grepInvert;
  expect(filter).toBeInstanceOf(RegExp);
  expect((filter as RegExp).test("ticket journey real Luna @paid")).toBe(true);
  expect((filter as RegExp).test("ticket journey personal rich draft")).toBe(false);
});
