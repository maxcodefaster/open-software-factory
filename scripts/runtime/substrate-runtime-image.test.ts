import { expect, test } from "bun:test";
import pins from "../../deploy/substrate/runtime-pins.json";

test("Factory native image keeps exact Factory tools and the official matching containerd daemon/shim API", async () => {
  const dockerfile = await Bun.file("deploy/substrate/Runtime.Dockerfile").text();
  expect(dockerfile).toContain(
    `--checksum=sha256:${pins.containerd.sha256} ${pins.containerd.url}`,
  );
  expect(dockerfile).toContain(pins.containerd.revision);
  for (const version of [
    "29.9.0",
    "5.7.0-dev.1e1c577",
    "v24.21.0",
    "0.89.0",
    `v${pins.containerd.version}`,
  ])
    expect(dockerfile).toContain(version);
  expect(dockerfile).toContain(
    "COPY deploy/substrate/rootless/runtime-child.sh /opt/factory-rootless/child.sh",
  );
  const child = await Bun.file("deploy/substrate/rootless/runtime-child.sh").text();
  expect(child).toContain("exec dockerd --rootless");
  expect(child).toContain("--default-cgroupns-mode=host");
  expect(child).not.toContain("--containerd=");
  expect(child).not.toContain("docker.sock:/");
  const bootstrap = await Bun.file("deploy/substrate/rootless/child.sh").text();
  expect(bootstrap).toContain("--containerd=/run/user/1000/docker/containerd/containerd.sock");
  const factory = await Bun.file("deploy/factory/Dockerfile").text();
  expect(factory).toContain("COPY deploy/substrate/pins.json ./deploy/substrate/pins.json");
  expect(await Bun.file(".dockerignore").text()).toContain("core.[0-9]*");
  expect(factory).toContain(
    "COPY services/substrate-control/go.mod services/substrate-control/go.sum ./",
  );
  expect(factory).toContain("CGO_ENABLED=0 go build -mod=readonly -trimpath");
  expect(factory).toContain(
    "COPY --from=substrate-control /factory-substrate-control /usr/local/bin/factory-substrate-control",
  );
  expect(factory).toContain("FROM substrate-control AS source-service");
  expect(factory).toContain(
    "COPY services/runtime-connector/go.mod services/runtime-connector/go.sum ./",
  );
  expect(factory).toContain("-o /factory-runtime-connector ./cmd/factory-runtime-connector");
  expect(factory).toContain(
    "COPY --from=source-service /factory-runtime-connector /usr/local/bin/factory-runtime-connector",
  );
});
