export type EditorRectangle = { left: number; top: number; right: number; bottom: number };

export function editorCommandHeight(
  anchor: EditorRectangle,
  bounds: EditorRectangle,
  gap: number,
  minimum: number,
) {
  const below = Math.max(0, bounds.bottom - anchor.bottom - gap);
  const above = Math.max(0, anchor.top - bounds.top - gap);
  return below >= minimum ? below : Math.max(above, below);
}

export function editorPopoverPosition(input: {
  anchor: EditorRectangle;
  bounds: EditorRectangle;
  width: number;
  height: number;
  gap: number;
  preferBelow: boolean;
  align?: "start" | "center";
}) {
  const { anchor, bounds, height, gap } = input;
  const width = Math.min(input.width, bounds.right - bounds.left);
  const center = (anchor.left + anchor.right) / 2;
  const left = Math.max(
    bounds.left,
    Math.min(
      (input.align ?? (input.preferBelow ? "start" : "center")) === "start"
        ? anchor.left
        : center - width / 2,
      bounds.right - width,
    ),
  );
  const above = anchor.top - gap - height;
  const below = anchor.bottom + gap;
  const fitsAbove = above >= bounds.top;
  const fitsBelow = below + height <= bounds.bottom;
  const top =
    input.preferBelow && fitsBelow
      ? below
      : fitsAbove
        ? above
        : fitsBelow
          ? below
          : Math.max(bounds.top, Math.min(below, bounds.bottom - height));
  return { left, top };
}
