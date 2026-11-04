import { expect, test } from "bun:test";
import { checkPasswordChange, passwordChangeMessage, passwordPolicy } from "./password-policy";
import * as policy from "./policy";

const valid = {
  currentPassword: "old-password-123",
  newPassword: "new-password-456",
  confirmPassword: "new-password-456",
};

test("a valid change passes and every refusal has its own explicit message", () => {
  expect(checkPasswordChange(valid)).toBeUndefined();
  expect(checkPasswordChange({ ...valid, currentPassword: "" })).toBe("current-required");
  expect(checkPasswordChange({ ...valid, newPassword: "short", confirmPassword: "short" })).toBe(
    "too-short",
  );
  const long = "x".repeat(passwordPolicy.maxLength + 1);
  expect(checkPasswordChange({ ...valid, newPassword: long, confirmPassword: long })).toBe(
    "too-long",
  );
  expect(checkPasswordChange({ ...valid, confirmPassword: "different-password-1" })).toBe(
    "mismatch",
  );
  expect(
    checkPasswordChange({
      currentPassword: valid.newPassword,
      newPassword: valid.newPassword,
      confirmPassword: valid.newPassword,
    }),
  ).toBe("unchanged");
  const messages = (
    ["current-required", "too-short", "too-long", "mismatch", "unchanged"] as const
  ).map(passwordChangeMessage);
  expect(new Set(messages).size).toBe(5);
  expect(passwordChangeMessage("too-short")).toContain(String(passwordPolicy.minLength));
});

test("length bounds match sign-in and the account policy is exported from policy.ts", () => {
  expect(passwordPolicy).toEqual({ minLength: 12, maxLength: 128 });
  expect(policy.checkPasswordChange).toBe(checkPasswordChange);
  expect(policy.PasswordChangeError).toBeDefined();
});

test("the exact length limits are accepted and one character beyond is not", () => {
  const edge = (length: number) => {
    const password = "a".repeat(length);
    return checkPasswordChange({
      currentPassword: "current",
      newPassword: password,
      confirmPassword: password,
    });
  };
  expect(edge(passwordPolicy.minLength)).toBeUndefined();
  expect(edge(passwordPolicy.minLength - 1)).toBe("too-short");
  expect(edge(passwordPolicy.maxLength)).toBeUndefined();
  expect(edge(passwordPolicy.maxLength + 1)).toBe("too-long");
});
