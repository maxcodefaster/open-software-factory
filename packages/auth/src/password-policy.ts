export const passwordPolicy = { minLength: 12, maxLength: 128 } as const;

export type PasswordChangeRefusal =
  | "current-required"
  | "mismatch"
  | "too-short"
  | "too-long"
  | "unchanged";

const passwordChangeMessages: Record<PasswordChangeRefusal, string> = {
  "current-required": "Enter your current password.",
  mismatch: "The new password and its confirmation differ.",
  "too-short": `The new password needs at least ${passwordPolicy.minLength} characters.`,
  "too-long": `The new password can have at most ${passwordPolicy.maxLength} characters.`,
  unchanged: "Choose a new password that differs from the current one.",
};

export function passwordChangeMessage(refusal: PasswordChangeRefusal) {
  return passwordChangeMessages[refusal];
}

export class PasswordChangeError extends Error {
  constructor(
    readonly kind: "refused" | "wrong-password" | "locked" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "PasswordChangeError";
  }
}

/** Checks everything about a password change that does not need the stored hash. */
export function checkPasswordChange(input: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}): PasswordChangeRefusal | undefined {
  if (!input.currentPassword) return "current-required";
  if (input.newPassword.length < passwordPolicy.minLength) return "too-short";
  if (input.newPassword.length > passwordPolicy.maxLength) return "too-long";
  if (input.newPassword !== input.confirmPassword) return "mismatch";
  if (input.newPassword === input.currentPassword) return "unchanged";
  return undefined;
}
