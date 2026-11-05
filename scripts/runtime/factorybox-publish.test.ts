import { expect, test } from "bun:test";
import { verifyPublishInputs } from "./factorybox-publish";

const image = `factorybox-worker-${"a".repeat(32)}@sha256:${"b".repeat(64)}`;
const build = {
  passed: true,
  architecture: "arm64",
  workerBuild: "factorybox-build-worker-x",
  image,
  executableSHA256: "c".repeat(64),
};
const receipt = {
  passed: true,
  cleanup: true,
  passedAt: "2026-11-04T20:00:00Z",
  worker: { image, executableSHA256: "c".repeat(64), architecture: "arm64", node: "orbstack" },
};

test("a conformance receipt for the exact build and architecture is accepted", () => {
  expect(verifyPublishInputs(build, receipt).architecture).toBe("arm64");
});

test("publishing refuses a receipt for other bytes or another architecture", () => {
  const worker = (change: object) => ({ ...receipt, worker: { ...receipt.worker, ...change } });
  expect(() => verifyPublishInputs(build, worker({ image: `x@sha256:${"d".repeat(64)}` }))).toThrow(
    "different image",
  );
  expect(() => verifyPublishInputs(build, worker({ executableSHA256: "e".repeat(64) }))).toThrow(
    "different executable",
  );
  expect(() => verifyPublishInputs(build, worker({ architecture: "amd64" }))).toThrow(
    "another architecture",
  );
  expect(() => verifyPublishInputs(build, { ...receipt, passed: false })).toThrow();
  expect(() => verifyPublishInputs({ ...build, passed: false }, receipt)).toThrow();
});
