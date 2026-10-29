import { expect, test } from "bun:test";
import { needsOwnedBrowserHost, runBrowserChecks } from "./browser";

test("direct UI checks own their host but discovery, explicit targets and live lanes do not", () => {
  expect(needsOwnedBrowserHost([], {})).toBe(true);
  expect(needsOwnedBrowserHost(["test/browser/usage-settings.spec.ts"], {})).toBe(true);
  for (const arg of ["--list", "--help", "-h"])
    expect(needsOwnedBrowserHost([arg], {})).toBe(false);
  for (const lane of ["native", "paid", "manual"])
    expect(needsOwnedBrowserHost([], { FACTORY_BROWSER_LANE: lane })).toBe(false);
  expect(needsOwnedBrowserHost([], { FACTORY_BROWSER_BASE_URL: "http://127.0.0.1:12345" })).toBe(
    false,
  );
});

for (const outcome of ["success", "failure", "throw", "host-failure", "cleanup-failure"] as const) {
  test(`owned browser ${outcome} retains the child verdict and cleans only its host and build`, async () => {
    const calls: string[] = [];
    const environment = {
      DATABASE_URL: "must-not-use-retained-database",
      FACTORY_ADMIN_PASSWORD: "must-not-use-retained-password",
      FACTORY_MODEL_API_KEY: "must-not-reach-child",
      FACTORY_LEARNING_MODEL_LIVE: "1",
      FACTORY_TEST_POSTGRES: "must-not-adopt-another-fixture",
    };
    const args = ["test/browser/usage-settings.spec.ts"];
    const result = runBrowserChecks(args, environment, {
      async build(input) {
        calls.push("build");
        input["FACTORY_BUILD_DIRECTORY"] = "/owned/browser-build";
        return async () => {
          calls.push("dispose-build");
        };
      },
      async host(input) {
        calls.push("host");
        expect(input["FACTORY_TEST_POSTGRES"]).toBeUndefined();
        expect(input["FACTORY_MODEL_API_KEY"]).toBeUndefined();
        expect(input["FACTORY_LEARNING_MODEL_LIVE"]).toBeUndefined();
        expect(input["FACTORY_BUILD_DIRECTORY"]).toBe("/owned/browser-build");
        if (outcome === "host-failure") throw new Error("Host preparation failed");
        return {
          base: "http://127.0.0.1:34567",
          databaseURL: "owned-database",
          email: "owned-admin",
          password: "owned-password",
          async dispose() {
            calls.push("dispose-host");
            if (outcome === "cleanup-failure") throw new Error("Host cleanup failed");
          },
        };
      },
      async run(selection, input) {
        calls.push("run");
        expect(selection).toEqual(args);
        expect(input["FACTORY_BROWSER_BASE_URL"]).toBe("http://127.0.0.1:34567");
        expect(input["DATABASE_URL"]).toBe("owned-database");
        expect(input["FACTORY_ADMIN_EMAIL"]).toBe("owned-admin");
        expect(input["FACTORY_ADMIN_PASSWORD"]).toBe("owned-password");
        expect(input["FACTORY_MODEL_API_KEY"]).toBeUndefined();
        expect(input["FACTORY_LEARNING_MODEL_LIVE"]).toBeUndefined();
        expect(input["FACTORY_BUILD_DIRECTORY"]).toBe("/owned/browser-build");
        if (outcome === "throw") throw new Error("Browser launch failed");
        return outcome === "failure" ? 7 : 0;
      },
    });
    if (outcome === "host-failure") await expect(result).rejects.toThrow("Host preparation failed");
    else if (outcome === "cleanup-failure")
      await expect(result).rejects.toThrow("Host cleanup failed");
    else if (outcome === "throw") await expect(result).rejects.toThrow("Browser launch failed");
    else expect(await result).toBe(outcome === "failure" ? 7 : 0);
    expect(calls).toEqual(
      outcome === "host-failure"
        ? ["build", "host", "dispose-build"]
        : ["build", "host", "run", "dispose-host", "dispose-build"],
    );
    expect(environment.DATABASE_URL).toBe("must-not-use-retained-database");
    expect(environment.FACTORY_ADMIN_PASSWORD).toBe("must-not-use-retained-password");
    expect(environment.FACTORY_MODEL_API_KEY).toBe("must-not-reach-child");
    expect("FACTORY_BUILD_DIRECTORY" in environment).toBe(false);
  });
}

test("an explicit caller keeps its environment and owns its existing host", async () => {
  const environment = {
    FACTORY_BROWSER_BASE_URL: "http://127.0.0.1:12345",
    DATABASE_URL: "caller-database",
    FACTORY_BUILD_DIRECTORY: "/caller/build",
  };
  const code = await runBrowserChecks(["--project=ui"], environment, {
    async build() {
      throw new Error("Must not build for caller");
    },
    async host() {
      throw new Error("Must not replace caller");
    },
    async run(args, input) {
      expect(args).toEqual(["--project=ui"]);
      expect(input).toBe(environment);
      return 3;
    },
  });
  expect(code).toBe(3);
});
