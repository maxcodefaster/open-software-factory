import { expect, type Page } from "@playwright/test";
import { z } from "zod";

export async function startEditorCompute(page: Page) {
  const frame = page.frameLocator('iframe[title="Factory IDE"]');
  await expect(frame.locator("#theia-app-shell")).toBeVisible({ timeout: 60_000 });
  await frame.locator(".lm-TabBar-tab").filter({ hasText: "Terminal" }).click();
  const iframe = page.locator('iframe[title="Factory IDE"]');
  await expect(iframe).toHaveAttribute("data-workspace-id", /^[a-f0-9-]{36}$/);
  const workspaceID = z.uuid().parse(await iframe.getAttribute("data-workspace-id"));
  const takeOver = frame.getByRole("button", { name: "Take over editing", exact: true });
  if (await takeOver.isVisible()) await takeOver.click();
  let observed: unknown;
  await expect
    .poll(
      async () => {
        observed = await frame.locator("body").evaluate(async (_body, id) => {
          const prefix = new URL("./", window.location.href).pathname;
          const response = await fetch(`${prefix}__factory/workspaces/${id}/runtime`, {
            credentials: "same-origin",
            cache: "no-store",
          });
          if (!response.ok) throw Error("Owned IDE runtime observation failed");
          return response.json();
        }, workspaceID);
        const state = z
          .object({
            workspaceID: z.literal(workspaceID),
            state: z.string(),
            failure: z.string().nullable(),
          })
          .parse(observed);
        if (state.failure || ["failed", "unavailable"].includes(state.state))
          throw Error(state.failure ?? `Owned Workspace became ${state.state}`);
        return state.state;
      },
      { timeout: 240_000, intervals: [1000] },
    )
    .toBe("ready");
  return z.object({ workspaceID: z.literal(workspaceID), attemptID: z.uuid() }).parse(observed);
}
