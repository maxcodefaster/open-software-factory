import { expect, test } from "bun:test";
import playwright from "../../playwright.config";
import {
  browserLane,
  controllerNeedsDatabase,
  integrationLane,
  integrationNeedsApplicationBuild,
} from "./lanes";

test("explicit lanes keep paid calls and retained-installation restarts outside defaults", () => {
  expect(integrationLane("test/integration/backup-runner.native.test.ts")).toBe("native");
  expect(controllerNeedsDatabase("test/integration/backup-runner.native.test.ts")).toBe(false);
  expect(integrationNeedsApplicationBuild("test/integration/backup-runner.native.test.ts")).toBe(
    false,
  );
  expect(integrationLane("test/integration/project-environment.test.ts")).toBe("controllers");
  expect(integrationLane("test/integration/native-skill-loading.test.ts")).toBe("native");
  expect(integrationLane("test/integration/substrate-adapter.native.test.ts")).toBe("native");
  expect(integrationLane("test/integration/substrate-rootless-proxy.native.test.ts")).toBe(
    "native",
  );
  expect(integrationLane("test/integration/substrate-workspaces.native.test.ts")).toBe("native");
  expect(integrationLane("test/integration/developer-ide-kubernetes.native.test.ts")).toBe(
    "native",
  );
  expect(integrationLane("test/integration/substrate-workspaces.test.ts")).toBe("controllers");
  expect(integrationLane("test/integration/substrate-verification.test.ts")).toBe("controllers");
  expect(integrationLane("test/integration/substrate-source.test.ts")).toBe("controllers");
  expect(integrationLane("test/integration/substrate-adapter.test.ts")).toBe("controllers");
  expect(integrationLane("test/integration/project-environments.live.test.ts")).toBe("live");
  expect(integrationLane("test/integration/openbao.test.ts")).toBe("native");
  expect(browserLane("agent-turn-live.spec.ts")).toBe("paid");
  expect(browserLane("project-agent.spec.ts")).toBe("paid");
  expect(browserLane("runtime-console.spec.ts")).toBe("native");
  expect(browserLane("skill-settings.spec.ts")).toBe("ui");
  expect(() => browserLane("unclassified.live.spec.ts")).toThrow("Unclassified");
});

test("writer input Stop requires native OpenCode but polling-only proofs stay in controllers", () => {
  expect(integrationLane("test/integration/substrate-writer-input-stop.test.ts")).toBe("native");
  for (const name of [
    "candidate-review-delivery",
    "candidate-review",
    "review-recording",
    "session-archive-store",
  ])
    expect(integrationLane(`test/integration/${name}.test.ts`)).toBe("controllers");
});

test("the isolated rootless proxy component needs neither Factory build nor PostgreSQL", () => {
  const component = "test/integration/substrate-rootless-proxy.native.test.ts";
  const product = "test/integration/substrate-workspaces.native.test.ts";
  expect(integrationNeedsApplicationBuild(component)).toBe(false);
  expect(controllerNeedsDatabase(component)).toBe(false);
  expect(integrationNeedsApplicationBuild(product)).toBe(true);
  expect(controllerNeedsDatabase("test/integration/bootstrap.test.ts")).toBe(true);
  expect([component].some(integrationNeedsApplicationBuild)).toBe(false);
  expect([component, product].some(integrationNeedsApplicationBuild)).toBe(true);
});

test("the default browser selection excludes explicitly paid cases in mixed journey files", () => {
  const filter = playwright.grepInvert;
  expect(filter).toBeInstanceOf(RegExp);
  expect((filter as RegExp).test("ticket journey real Luna @paid")).toBe(true);
  expect((filter as RegExp).test("ticket journey personal rich draft")).toBe(false);
});

test("self-contained protocol and PostgreSQL proofs do not acquire an unused shared database", () => {
  for (const name of ["attachments-store", "conversation-persistence", "review-media"]) {
    const path = `test/integration/${name}.test.ts`;
    expect(controllerNeedsDatabase(path)).toBe(false);
    expect(integrationNeedsApplicationBuild(path)).toBe(false);
  }
  expect(controllerNeedsDatabase("test/integration/substrate-adapter.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/substrate-adapter.native.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/developer-ide-kubernetes.native.test.ts")).toBe(
    false,
  );
  expect(controllerNeedsDatabase("test/integration/native-project-releases.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/schema-baseline.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/substrate-workspaces.native.test.ts")).toBe(
    false,
  );
  expect(controllerNeedsDatabase("test/integration/substrate-workspaces.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/substrate-verification.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/substrate-runtime-list.test.ts")).toBe(false);
  expect(integrationLane("test/integration/substrate-runtime-list.test.ts")).toBe("controllers");
  for (const name of [
    "runtime-app-origins",
    "runtime-declared-apps",
    "project-preparation",
    "verification-cancellation",
    "usage-cleanup",
  ]) {
    const path = `test/integration/${name}.test.ts`;
    expect(integrationLane(path)).toBe("controllers");
    expect(controllerNeedsDatabase(path)).toBe(false);
  }
  expect(controllerNeedsDatabase("test/integration/substrate-source.test.ts")).toBe(false);
  expect(controllerNeedsDatabase("test/integration/openbao.test.ts")).toBe(false);
  expect(integrationNeedsApplicationBuild("test/integration/openbao.test.ts")).toBe(false);
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

test("database-only feature checks skip the application build while endpoint checks keep it", () => {
  for (const name of [
    "schema-baseline",
    "postgres-baseline",
    "project-release-store",
    "mcp-library",
    "mcp-oauth",
    "mcp-cancellation",
    "agent-read",
    "agent-turn-store",
    "coding-source-dispatch-fence",
    "change-document-drizzle",
    "delivery-controller-drizzle",
    "inbox",
    "skills-controllers-drizzle",
    "substrate-drizzle",
    "substrate-bound-provisioning",
    "substrate-lifecycle-facts",
    "usage-journal",
    "usage-policy",
    "coding-budget",
    "workspace-sharing",
    "workspace-commands",
    "workspace-container-files",
    "substrate-source",
    "substrate-source-access",
    "developer-ide",
    "developer-ide-access-recovery",
  ])
    expect(integrationNeedsApplicationBuild(`test/integration/${name}.test.ts`)).toBe(false);
  expect(integrationNeedsApplicationBuild("test/integration/server-function-runtime.test.ts")).toBe(
    true,
  );
});
