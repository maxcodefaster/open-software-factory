import type { EditorRectangle } from "./editor-popover-position";

export function editorTextRectangles(root: HTMLElement, bounds: EditorRectangle) {
  const rectangles: EditorRectangle[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (
      !node.textContent?.trim() ||
      node.parentElement?.closest(".selection-toolbar, .caret-command-menu")
    ) {
      continue;
    }
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > bounds.top &&
        rect.top < bounds.bottom
      ) {
        rectangles.push(rect);
      }
    }
  }
  return rectangles;
}
