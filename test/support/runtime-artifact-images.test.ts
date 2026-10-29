import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import upstream from "../../upstream.json";

test("runtime Compose pins the upstream configured-input grant fix without disabling Bake security", async () => {
  const dockerfile = await readFile("deploy/runtime-host/Dockerfile", "utf8");
  const environment = await readFile("services/runtime-connector/connector/environment.go", "utf8");
  expect(upstream.dockerCompose.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(upstream.dockerCompose.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(upstream.dockerCompose.source).toContain(upstream.dockerCompose.commit);
  expect(dockerfile).toContain(`FROM ${upstream.go.image} AS compose`);
  expect(dockerfile).toContain(
    `ADD --checksum=sha256:${upstream.dockerCompose.sha256} ${upstream.dockerCompose.source}`,
  );
  expect(dockerfile).toContain(
    `github.com/docker/compose/v5/internal.Version=v${upstream.dockerCompose.version}`,
  );
  expect(dockerfile).toContain(
    "COPY --from=compose /docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose",
  );
  expect(dockerfile).toContain(
    "COPY --from=compose /src/compose/LICENSE /usr/local/share/licenses/docker-compose/LICENSE",
  );
  expect(dockerfile).toContain(
    `test "$(docker compose version --short)" = "${upstream.dockerCompose.version}"`,
  );
  expect(dockerfile).toContain(`FROM ${upstream.docker.image} AS runtime-host-base`);
  for (const source of [dockerfile, environment]) {
    expect(source).not.toContain("BUILDX_BAKE_ENTITLEMENTS_FS=0");
    expect(source).not.toContain("COMPOSE_BAKE");
  }
});

test("both native release jobs prove configured Compose inputs before pushing the runtime image", async () => {
  const [workflow, proof] = await Promise.all([
    readFile(".github/workflows/images.yaml", "utf8"),
    readFile("scripts/runtime/compose-inputs-proof.sh", "utf8"),
  ]);
  expect(workflow).toContain("runner: ubuntu-24.04-arm");
  expect(workflow).toContain("exporter=(--load)");
  const gate = workflow.indexOf('bash scripts/runtime/compose-inputs-proof.sh "$image_id"');
  const push = workflow.indexOf('docker push "$image"');
  expect(gate).toBeGreaterThan(0);
  expect(push).toBeGreaterThan(gate);
  expect(proof).toContain('test "$image_arch" = "$server_arch"');
  expect(proof).toContain("BUILDX_BAKE_ENTITLEMENTS_FS=1");
  expect(proof).toContain("--network=none --cpus=3 --memory=3g");
  expect(proof).toContain("configuredDockerfileBuilt");
  expect(proof).toContain("unconfiguredReadRefused");
});

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
