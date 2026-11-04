import { z } from "zod";

// An admitted kernel is one release or a comma-separated list of releases, each
// optionally using `*` as a wildcard (for example `5.15.0-*-azure,6.8.0-*-azure`).
// Node image upgrades change the release string, so managed clusters need a
// pattern. It only gates admission. The node boot ID, Pod, claim and native
// worker identities still pin every retained worker.
const alternative = /^[a-zA-Z0-9._+*-]+$/;
const maximumAlternatives = 16;

function alternatives(value: string) {
  return value.split(",").map((part) => part.trim());
}

export function validFactoryboxKernelPolicy(value: string) {
  const parts = alternatives(value);
  return (
    parts.length <= maximumAlternatives &&
    parts.every((part) => alternative.test(part) && /[^*]/.test(part))
  );
}

export const factoryboxKernelPolicy = z
  .string()
  .min(1)
  .max(256)
  .refine(validFactoryboxKernelPolicy, {
    message:
      "Kernel must be a release or comma-separated list of releases, using * only as a wildcard",
  });

export function factoryboxKernelMatches(policy: string, release: string) {
  if (!validFactoryboxKernelPolicy(policy)) return false;
  return alternatives(policy).some((part) =>
    new RegExp(
      `^${part
        .split("*")
        .map((segment) => segment.replace(/[.+-]/g, "\\$&"))
        .join(".*")}$`,
    ).test(release),
  );
}
