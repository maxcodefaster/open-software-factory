import { expect, test } from "bun:test";
import { environmentBundle } from "../../../../packages/project-domain/src/environment";
import { selectRuntimeEnvironment } from "./runtime";

test("registry publication consent remains in Factory, outside the Connector credential protocol", () => {
  const bundle = environmentBundle.parse({
    variables: [],
    registries: [
      {
        host: "runtime.registry.test",
        username: "owned-runtime",
        password: "owned-runtime-password",
        certificate: "",
        verification: false,
        publish: true,
      },
      {
        host: "verification.registry.test",
        username: "owned-verification",
        password: "owned-verification-password",
        certificate: "",
        verification: true,
        publish: false,
      },
    ],
  });
  const runtime = selectRuntimeEnvironment(bundle, false);
  expect(runtime.registries).toHaveLength(2);
  expect(runtime.registries[0]?.password).toBe("owned-runtime-password");
  expect(JSON.stringify(runtime)).not.toContain('"publish"');
  const verification = selectRuntimeEnvironment(bundle, true);
  expect(verification.registries).toHaveLength(1);
  expect(verification.registries[0]?.host).toBe("verification.registry.test");
  expect(JSON.stringify(verification)).not.toContain('"publish"');
  expect(bundle.registries[0]?.publish).toBe(true);
});
