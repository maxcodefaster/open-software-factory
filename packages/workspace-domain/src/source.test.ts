import { expect, test } from "bun:test";
import { workspaceSourceIdentity, workspaceSourceCapability } from "./source";

test("source identity and authority are deterministic and independent of runtime Attempts", () => {
  const workspaceID = "11111111-1111-5111-8111-111111111111";
  const first = workspaceSourceIdentity(workspaceID, 1);
  expect(workspaceSourceIdentity(workspaceID, 1)).toEqual(first);
  expect(workspaceSourceCapability("secret", first)).toBe(
    workspaceSourceCapability("secret", first),
  );
  expect(workspaceSourceCapability("secret", first)).not.toBe(
    workspaceSourceCapability("secret", workspaceSourceIdentity(workspaceID, 2)),
  );
  for (const epoch of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => workspaceSourceIdentity(workspaceID, epoch)).toThrow();
  expect(() => workspaceSourceIdentity("../other", 1)).toThrow();
});
