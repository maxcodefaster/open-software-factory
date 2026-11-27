import { expect, test } from "bun:test";
import { environmentBundle } from "#project-domain/environment";
import { selectRuntimeEnvironment } from "./runtime";

test("environment selection preserves Runtime and explicit Verification boundaries", () => {
  const bundle = environmentBundle.parse({
    variables: [
      { name: "NPM_TOKEN", runtime: true, verification: false },
      { name: "VERIFIED_RUNTIME", runtime: true, verification: true },
      { name: "VERIFICATION_ONLY", runtime: false, verification: true },
      { name: "DISABLED", runtime: false, verification: false },
    ].map((variable) => ({ ...variable, value: `owned-${variable.name}` })),
  });
  const runtime = selectRuntimeEnvironment(bundle, false);
  expect(runtime).toEqual({ variables: bundle.variables.slice(0, 2) });
  const verification = selectRuntimeEnvironment(bundle, true);
  expect(verification).toEqual({ variables: bundle.variables.slice(1, 2) });
  expect(verification.variables[0]?.value).toBe("owned-VERIFIED_RUNTIME");
  expect(bundle.variables).toHaveLength(4);
});

test("empty Environment selection has no image-pull or build configuration", () => {
  for (const verification of [false, true])
    expect(selectRuntimeEnvironment({ variables: [] }, verification)).toEqual({ variables: [] });
});
