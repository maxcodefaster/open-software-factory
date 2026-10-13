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
  avoid?: readonly EditorRectangle[];
}) {
  const { anchor, bounds, height, gap } = input;
  const width = Math.min(input.width, bounds.right - bounds.left);
  const center = (anchor.left + anchor.right) / 2;
  const left = Math.max(
    bounds.left,
    Math.min(input.preferBelow ? anchor.left : center - width / 2, bounds.right - width),
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
  const fallback = { left, top };
  const obstacles = input.avoid ?? [];
  if (!obstacles.length) return fallback;
  const candidates = [fallback];
  const horizontal = [left, bounds.left, bounds.right - width];
  const vertical = [
    top,
    bounds.top,
    bounds.bottom - height,
    ...obstacles.flatMap((rect) => [rect.top - height - gap, rect.bottom + gap]),
  ];
  for (const x of horizontal) {
    for (const y of vertical) {
      if (y >= bounds.top && y + height <= bounds.bottom) candidates.push({ left: x, top: y });
    }
  }
  const clear = candidates.filter(
    (candidate) =>
      !obstacles.some(
        (rect) =>
          candidate.left < rect.right + gap &&
          candidate.left + width > rect.left - gap &&
          candidate.top < rect.bottom + gap &&
          candidate.top + height > rect.top - gap,
      ),
  );
  const distance = (candidate: typeof fallback) =>
    (candidate.left + width / 2 - center) ** 2 + (candidate.top - top) ** 2;
  clear.sort((a, b) => distance(a) - distance(b));
  return clear[0];
}
