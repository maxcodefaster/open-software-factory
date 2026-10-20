import { expect, test } from "bun:test";
import { authorizedFactoryOrigin } from "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-parent-context";

test("independent IDE selection trusts authenticated context even when grant redemption suppresses referrer", async () => {
  const href =
    "http://user.1.h3000.editor.runtime.localhost:3000/editor/11111111-1111-4111-8111-111111111111/1/?workspace=source";
  const fetcher: Parameters<typeof authorizedFactoryOrigin>[2] = async (input, init) => {
    expect(String(input)).toBe(
      "http://user.1.h3000.editor.runtime.localhost:3000/editor/11111111-1111-4111-8111-111111111111/1/__factory/context",
    );
    expect(init?.credentials).toBe("same-origin");
    return Response.json({ factoryOrigin: "http://127.0.0.1:3000" });
  };
  expect(await authorizedFactoryOrigin(href, "", fetcher)).toBe("http://127.0.0.1:3000");
  expect(await authorizedFactoryOrigin(href, "https://untrusted.invalid", fetcher)).toBe(
    "http://127.0.0.1:3000",
  );
  for (const response of [
    new Response(null, { status: 401 }),
    Response.json({ factoryOrigin: "file:///source" }),
    Response.json({ factoryOrigin: "https://factory.invalid/path" }),
    Response.json({}),
  ])
    await expect(
      authorizedFactoryOrigin(href, "https://untrusted.invalid", async () => response),
    ).rejects.toThrow();
});
