import { expect, type Page } from "@playwright/test";

export async function startNewConversation(page: Page) {
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Conversation history", exact: true });
  await menu.getByRole("menuitem", { name: "New chat", exact: true }).click();
  await expect(menu).toBeHidden();
}

export async function chooseConversation(page: Page, id: string) {
  const trigger = page.getByRole("button", { name: "Conversation", exact: true });
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Conversation history", exact: true });
  await menu.locator(`[data-conversation-id="${id}"]`).click();
  await expect(trigger).toHaveAttribute("data-context-id", id);
  await expect(menu).toBeHidden();
}
