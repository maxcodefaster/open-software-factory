import { expect, test } from "bun:test";
import {
  externalAccessInput,
  publishRelease,
  releaseContract,
  releasePackageOwner,
  releaseVersion,
  versionSuggestions,
} from "./release";

test("human-controlled release versions offer distinct stable bumps", () => {
  expect(versionSuggestions("1.4.9")).toEqual({ patch: "1.4.10", minor: "1.5.0", major: "2.0.0" });
  expect(versionSuggestions(null).patch).toBe("0.0.1");
  for (const version of ["latest", "v1.2.3", "1.2", "01.2.3", "1.2.3-beta", "../../1.0.0"])
    expect(releaseVersion.safeParse(version).success).toBe(false);
});
test("release and access commands cannot smuggle a target or widen scope", () => {
  const projectID = crypto.randomUUID();
  expect(releasePackageOwner(projectID)).toBe(releasePackageOwner(projectID));
  expect(releasePackageOwner(projectID).length).toBeLessThanOrEqual(40);
  expect(releasePackageOwner(projectID)).not.toBe(releasePackageOwner(crypto.randomUUID()));
  expect(
    publishRelease.safeParse({
      commandID: crypto.randomUUID(),
      commitSHA: "a".repeat(40),
      version: "1.2.3",
      notes: "",
      target: "production",
    }).success,
  ).toBe(false);
  expect(
    externalAccessInput.safeParse({
      commandID: crypto.randomUUID(),
      name: "Reader",
      scope: "write",
    }).success,
  ).toBe(false);
  expect(
    releaseContract.safeParse({ schemaVersion: 1, images: ["web"], chart: "web" }).success,
  ).toBe(false);
  expect(
    releaseContract.safeParse({ schemaVersion: 1, images: ["https://foreign/image"] }).success,
  ).toBe(false);
});
