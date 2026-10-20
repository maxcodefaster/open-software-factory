import { expect, test } from "@playwright/test";
import { developerIDEOrigin } from "../../apps/factory/src/developer-ide-origin";
import { developerIDEPath } from "../../apps/factory/src/workspace/developer-ide-access";

test("local installations with the same editor owner and epoch cannot overwrite each other's cookies", async ({
  context,
}) => {
  const userID = "01994a7d-0000-7000-8000-000000000001";
  const epoch = 1;
  const first = new URL(developerIDEOrigin("http://127.0.0.1:3000", userID, epoch));
  const second = new URL(developerIDEOrigin("http://127.0.0.1:3100", userID, epoch));
  const path = developerIDEPath(userID, epoch);
  for (const name of ["factory_editor_access", "theia-connection-token"]) {
    await context.addCookies([
      {
        name,
        value: `${name}-first`,
        domain: first.hostname,
        path,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await context.addCookies([
      {
        name,
        value: `${name}-second`,
        domain: second.hostname,
        path,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const firstCookies = await context.cookies(new URL(path, first).href);
    const secondCookies = await context.cookies(new URL(path, second).href);
    expect(firstCookies.find((cookie) => cookie.name === name)?.value).toBe(`${name}-first`);
    expect(secondCookies.find((cookie) => cookie.name === name)?.value).toBe(`${name}-second`);
  }
  expect(first.hostname).not.toBe(second.hostname);
});
