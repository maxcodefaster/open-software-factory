import type { ReadonlyJSONValue } from "@rocicorp/zero";

type Issue = { readonly message: string };
export interface FactoryValidator<T extends ReadonlyJSONValue> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: "factory";
    readonly types: { readonly input: T; readonly output: T };
    readonly validate: (
      value: unknown,
    ) => { readonly value: T } | { readonly issues: readonly Issue[] };
  };
}

export function validator<T extends ReadonlyJSONValue>(
  parse: (value: unknown) => T,
): FactoryValidator<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "factory",
      types: undefined as never,
      validate(value) {
        try {
          return { value: parse(value) };
        } catch (cause) {
          return {
            issues: [{ message: cause instanceof Error ? cause.message : "Invalid input" }],
          };
        }
      },
    },
  };
}

export function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected object");
  return value as Readonly<Record<string, unknown>>;
}

export function uuid(value: unknown, field: string) {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value)) {
    throw new TypeError(`${field} must be a UUID`);
  }
  return value;
}

export function text(value: unknown, field: string, blank = true) {
  if (typeof value !== "string" || (!blank && !value.trim())) {
    throw new TypeError(`${field} must be ${blank ? "text" : "non-blank text"}`);
  }
  return value;
}

export function integer(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}
