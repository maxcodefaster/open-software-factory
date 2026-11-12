import { expect, test } from "bun:test";
import { verificationRegistryResponse } from "../fixtures/verification-pool-registry";

test("native containerd HEAD admission retains the actual manifest size and digest", async () => {
  const response = verificationRegistryResponse(
    new Response(null, {
      headers: {
        "content-length": "6604",
        "docker-content-digest": `sha256:${"a".repeat(64)}`,
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
    }),
    "HEAD",
  );
  expect(response.headers.get("content-length")).toBe("6604");
  expect(response.headers.get("docker-content-digest")).toBe(`sha256:${"a".repeat(64)}`);
  expect(await response.text()).toBe("");
});

test("opaque registry GET keeps raw sizes but drops an already-decoded content encoding", async () => {
  const raw = verificationRegistryResponse(
    new Response("abc", { headers: { "content-length": "3" } }),
    "GET",
  );
  expect(raw.headers.get("content-length")).toBe("3");
  expect(await raw.text()).toBe("abc");
  const decoded = verificationRegistryResponse(
    new Response("abc", { headers: { "content-encoding": "gzip", "content-length": "23" } }),
    "GET",
  );
  expect(decoded.headers.has("content-encoding")).toBe(false);
  expect(decoded.headers.has("content-length")).toBe(false);
  expect(await decoded.text()).toBe("abc");
});
