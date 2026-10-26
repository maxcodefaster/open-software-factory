import { expect, test } from "bun:test";
import { workspaceSourceCapability, workspaceSourceIdentity } from "./source";

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

test("Source resources use the full Workspace identity before namespaces can be shared", () => {
  const first = workspaceSourceIdentity("11111111-1111-5111-8111-111111111111", 1);
  const sibling = workspaceSourceIdentity("11111111-1111-5111-8111-222222222222", 1);
  for (const field of ["serviceID", "podName", "secretName"] as const) {
    expect(first[field]).not.toBe(sibling[field]);
    expect(first[field]).toContain("11111111111151118111111111111111");
    expect(sibling[field]).toContain("11111111111151118111222222222222");
    expect(first[field]).not.toBe(workspaceSourceIdentity(first.workspaceID, 2)[field]);
    const longest = workspaceSourceIdentity(first.workspaceID, Number.MAX_SAFE_INTEGER)[field];
    expect(longest.length).toBeLessThanOrEqual(63);
    expect(longest).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
  }
});
