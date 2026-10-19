import { expect, mock, test } from "bun:test";
import type { StatusBarEntry } from "../../deploy/theia-ide/node_modules/@theia/core/lib/browser/status-bar/status-bar";

const writes: Array<{ id: string; entry: StatusBarEntry }> = [];
function latestEntry() {
  const write = writes.at(-1);
  if (!write) throw new Error("Status bar did not receive the updated entry");
  return write.entry;
}
mock.module(
  "../../deploy/theia-ide/node_modules/@theia/core/lib/browser/status-bar/status-bar",
  () => ({
    StatusBarImpl: class {
      async setElement(id: string, entry: StatusBarEntry) {
        writes.push({ id, entry });
      }
    },
  }),
);
const markdownInputs: string[] = [];
mock.module(
  "../../deploy/theia-ide/node_modules/@theia/monaco-editor-core/esm/vs/base/browser/markdownRenderer",
  () => ({
    renderAsPlaintext(value: { value: string }) {
      markdownInputs.push(value.value);
      return "Settings overridden for this session";
    },
  }),
);
const { FactoryStatusBar } = await import(
  "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-status-bar"
);

test("rich status hovers keep their commands and explicit accessibility names", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  class ElementFixture {
    textContent = "TypeScript syntax checks only";
  }
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: ElementFixture });
  const status = Object.create(FactoryStatusBar.prototype) as InstanceType<typeof FactoryStatusBar>;
  try {
    const tooltip = { value: "**Settings**", isTrusted: { enabledCommands: ["openSettings"] } };
    await status.setElement("session", {
      alignment: 0,
      text: "$(warning) Session Preferences (1)",
      tooltip,
      command: "openSettings",
    });
    const written = latestEntry();
    expect(written.accessibilityInformation?.label).toBe(
      "Session Preferences (1), Settings overridden for this session",
    );
    expect(written.tooltip).toBe(tooltip);
    expect(written.command).toBe("openSettings");
    expect(markdownInputs).toEqual(["**Settings**"]);
    const content = new ElementFixture() as unknown as HTMLElement;
    await status.setElement("language", { alignment: 0, text: "$(bracket)", tooltip: content });
    expect(latestEntry().accessibilityInformation?.label).toBe("TypeScript syntax checks only");
    let calls = 0;
    await status.setElement("lazy", {
      alignment: 0,
      text: "Details",
      tooltip: () => {
        calls++;
        return "Lazy content";
      },
    });
    expect(calls).toBe(0);
    expect(latestEntry().accessibilityInformation?.label).toBe("Details");
    const explicit = {
      alignment: 0,
      text: "$(warning)",
      accessibilityInformation: { label: "Original name", role: "button" },
    };
    await status.setElement("explicit", explicit);
    expect(latestEntry()).toBe(explicit);
  } finally {
    if (previous) Object.defineProperty(globalThis, "HTMLElement", previous);
    else Reflect.deleteProperty(globalThis, "HTMLElement");
  }
});
