import { z } from "zod";

// The kernel is not a pin. Unset, empty or `*` admits any kernel and leaves the
// decision to the worker's own capability gate. An operator who wants to restrict
// nodes sets one release or a comma-separated list of releases, each optionally
// using `*` as a wildcard (for example `5.15.0-*-azure,6.8.0-*-azure`). It only
// gates admission. The node boot ID, Pod, claim and native worker identities
// still pin every retained worker.
const alternative = /^[a-zA-Z0-9._+*-]+$/;
const maximumAlternatives = 16;

function alternatives(value: string) {
  return value.split(",").map((part) => part.trim());
}

function unrestricted(value: string | undefined) {
  return value === undefined || value.trim() === "" || value.trim() === "*";
}

export function validFactoryboxKernelPolicy(value: string) {
  if (unrestricted(value)) return true;
  const parts = alternatives(value);
  return (
    parts.length <= maximumAlternatives &&
    parts.every((part) => alternative.test(part) && /[^*]/.test(part))
  );
}

export const factoryboxKernelPolicy = z
  .string()
  .max(256)
  .refine(validFactoryboxKernelPolicy, {
    message:
      "Kernel must be empty, *, or a comma-separated list of releases using * only as a wildcard",
  })
  .optional();

// The restriction an operator configured, or undefined when any kernel is allowed.
export function factoryboxKernelRestriction(policy: string | undefined) {
  return unrestricted(policy) ? undefined : policy?.trim();
}

export function factoryboxKernelMatches(policy: string | undefined, release: string) {
  if (unrestricted(policy)) return true;
  if (!policy || !validFactoryboxKernelPolicy(policy)) return false;
  return alternatives(policy).some((part) =>
    new RegExp(
      `^${part
        .split("*")
        .map((segment) => segment.replace(/[.+-]/g, "\\$&"))
        .join(".*")}$`,
    ).test(release),
  );
}
