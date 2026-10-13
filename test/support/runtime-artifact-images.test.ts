import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import upstream from "../../upstream.json";

test("runtime hosts contain only tools for their fixed execution role", async () => {
  const dockerfile = await readFile("deploy/runtime-host/Dockerfile", "utf8");
  const base = dockerfile
    .split(" AS runtime-host\n")[1]
    ?.split("FROM runtime-host AS build-runtime-host")[0];
  expect(base).toBeDefined();
  expect(base).toContain("@devcontainers/cli@0.89.0");
  expect(base).not.toContain("opencode");
  expect(base).not.toContain("forgejo-runner");
  expect(base).not.toContain("theia");
  const build = dockerfile
    .split("FROM runtime-host AS build-runtime-host")[1]
    ?.split("FROM runtime-host AS verification-runtime-host")[0];
  expect(build).toContain("COPY --from=build-tool /opt/factory/opencode/opencode");
  expect(build).not.toContain("forgejo-runner");
  const verification = dockerfile
    .split("FROM runtime-host AS verification-runtime-host")[1]
    ?.split("FROM runtime-host AS runtime")[0];
  expect(verification).toContain("COPY --from=verification-tool /usr/local/bin/forgejo-runner");
  expect(verification).not.toContain("opencode");
});

test("Project prebuild identity binds the same integrity-checked Dev Containers CLI shipped by the host", async () => {
  const [producer, dockerfile] = await Promise.all([
    readFile("services/runtime-connector/connector/prebuild.go", "utf8"),
    readFile("deploy/runtime-host/Dockerfile", "utf8"),
  ]);
  expect(producer).toContain(`const prebuildCLIVersion = "${upstream.devcontainersCli.version}"`);
  expect(producer).toContain(
    `const prebuildCLIIntegrity = "${upstream.devcontainersCli.integrity}"`,
  );
  expect(dockerfile).toContain(
    "COPY --from=connector /factory-project-prebuild /usr/local/bin/factory-project-prebuild",
  );
});
