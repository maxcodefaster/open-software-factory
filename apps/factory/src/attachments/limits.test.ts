import { expect, test } from "bun:test";
import { parse } from "yaml";
import { attachmentLimits } from "../../../../packages/conversation-domain/src/attachments";

test("operator configuration examples and Helm use the same attachment defaults", async () => {
  const values = parse(
    await Bun.file(new URL("../../../../deploy/helm/factory/values.yaml", import.meta.url)).text(),
  ) as { attachments: Record<string, number> };
  const environment = await Bun.file(new URL("../../../../.env.example", import.meta.url)).text();
  for (const [name, bytes] of Object.entries(attachmentLimits)) {
    expect(values.attachments[name]).toBe(bytes);
    const variable = name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
    expect(environment).toContain(`# FACTORY_ATTACHMENT_${variable}=${bytes}`);
  }
  expect(values.attachments).not.toHaveProperty("projectBytes");
  expect(values.attachments).not.toHaveProperty("installationBytes");
  expect(environment).not.toContain("FACTORY_ATTACHMENT_PROJECT_BYTES");
  expect(environment).not.toContain("FACTORY_ATTACHMENT_INSTALLATION_BYTES");
});
