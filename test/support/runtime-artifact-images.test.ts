import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import upstream from "../../upstream.json";

test("one runtime host contains role tools while the independent editor remains separate", async () => {
  const dockerfile = await readFile("deploy/runtime-host/Dockerfile", "utf8");
  const base = dockerfile
    .split(" AS runtime-host-base\n")[1]
    ?.split("FROM runtime-host-base AS runtime-host")[0];
  expect(base).toBeDefined();
  expect(base).toContain("@devcontainers/cli@0.89.0");
  expect(base).not.toContain("opencode");
  expect(base).not.toContain("forgejo-runner");
  expect(base).not.toContain("theia");
  expect(base).not.toContain("COPY --from=language-tools");
  const runtime = dockerfile
    .split("FROM runtime-host-base AS runtime-host")[1]
    ?.split("FROM runtime-host AS runtime")[0];
  expect(runtime).toContain("COPY --from=language-tools");
  expect(runtime).toContain("COPY --from=language-node-glibc");
  expect(runtime).toContain("COPY --from=language-node-musl");
  expect(runtime).toContain("COPY --from=bun-tool");
  expect(runtime).toContain("COPY --from=build-tool /opt/factory/opencode/opencode");
  expect(runtime).toContain("COPY --from=verification-tool /usr/local/bin/forgejo-runner");
  expect(runtime).not.toContain("theia");
  expect(dockerfile).not.toContain("AS build-runtime-host");
  expect(dockerfile).not.toContain("AS verification-runtime-host");
  const editor = dockerfile.split(" AS developer-ide\n")[1]?.split(" AS runtime-host-base")[0];
  expect(editor).toContain("ENV THEIA_CONFIG_DIR=/home/node/.factory-theia");
  expect(editor).not.toContain("COPY --from=language-tools");
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
