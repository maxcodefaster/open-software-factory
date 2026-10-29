import { expect, test } from "bun:test";
import playwright from "../../playwright.config";
import { browserLane, controllerNeedsDatabase, integrationLane } from "./lanes";

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

test("self-contained protocol and PostgreSQL proofs do not acquire an unused shared database", () => {
  expect(controllerNeedsDatabase("test/integration/postgres-baseline.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/server-function-knowledge.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/server-function-workspaces.test.ts")).toBe(
    false,
  );
  expect(controllerNeedsDatabase("test/integration/server-function-attachments.test.ts")).toBe(
    false,
  );
  expect(controllerNeedsDatabase("test/integration/server-function-writer-review.test.ts")).toBe(
    false,
  );
  expect(controllerNeedsDatabase("test/integration/server-function-mcp-inputs.test.ts")).toBe(
    false,
  );
  expect(controllerNeedsDatabase("test/integration/server-function-setup.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/server-function-skills.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/server-function-settings.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/server-function-access.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/server-functions.test.ts")).toBe(true);
  expect(controllerNeedsDatabase("test/integration/bootstrap.test.ts")).toBe(true);
  expect(controllerNeedsDatabase("test/integration/project-setup-observation.test.ts")).toBe(true);
});
