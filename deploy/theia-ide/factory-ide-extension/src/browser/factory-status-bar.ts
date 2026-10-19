import { StatusBarImpl, type StatusBarEntry } from "@theia/core/lib/browser/status-bar/status-bar";
import { MarkdownString } from "@theia/core/lib/common/markdown-rendering/markdown-string";
import { injectable } from "@theia/core/shared/inversify";
import { renderAsPlaintext } from "@theia/monaco-editor-core/esm/vs/base/browser/markdownRenderer";

@injectable()
export class FactoryStatusBar extends StatusBarImpl {
  override setElement(id: string, entry: StatusBarEntry): Promise<void> {
    if (entry.accessibilityInformation) return super.setElement(id, entry);
    const title = (entry.name || entry.text).replace(/\$\([^)]+\)/g, "").trim();
    const tooltip =
      typeof entry.tooltip === "string"
        ? entry.tooltip
        : MarkdownString.is(entry.tooltip)
          ? renderAsPlaintext({ value: entry.tooltip.value })
          : entry.tooltip instanceof HTMLElement
            ? (entry.tooltip.textContent ?? "")
            : "";
    const description = tooltip.replace(/\s+/g, " ").trim();
    const label = [...new Set([title, description].filter(Boolean))].join(", ") || "Editor status";
    // Keep the original rich hover, trust restrictions, command and click handler.
    // Only the upstream string-coercing accessibility fallback needs replacement.
    return super.setElement(id, { ...entry, accessibilityInformation: { label } });
  }
}
