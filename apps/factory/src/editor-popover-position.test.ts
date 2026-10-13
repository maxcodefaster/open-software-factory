import { expect, test } from "bun:test";
import { editorCommandHeight, editorPopoverPosition } from "./editor-popover-position";

const bounds = { left: 400, top: 120, right: 1100, bottom: 820 };
const anchor = { left: 430, top: 250, right: 480, bottom: 274 };
const input = { anchor, bounds, width: 240, height: 40, gap: 8, preferBelow: false };

test("command menus shrink to available caret space before calculating placement", () => {
  const caret = { left: 640, right: 640, top: 499, bottom: 516 };
  const height = editorCommandHeight(caret, bounds, 8, 96);
  expect(height).toBe(296);
  expect(editorPopoverPosition({ ...input, anchor: caret, height, preferBelow: true })).toEqual({
    left: 640,
    top: 524,
  });
  expect(editorCommandHeight({ ...caret, top: 790, bottom: 810 }, bounds, 8, 96)).toBe(662);
});

test("keeps the measured link editor inside the visible document", () => {
  expect(editorPopoverPosition(input)).toEqual({ left: 400, top: 202 });
  expect(
    editorPopoverPosition({ ...input, anchor: { ...anchor, left: 1060, right: 1090 } }),
  ).toEqual({ left: 860, top: 202 });
});

test("places formatting below a selection when the top edge has no room", () => {
  expect(editorPopoverPosition({ ...input, anchor: { ...anchor, top: 124, bottom: 148 } })).toEqual(
    { left: 400, top: 156 },
  );
});

test("prefers slash commands below the caret but flips at the bottom edge", () => {
  expect(editorPopoverPosition({ ...input, preferBelow: true })).toEqual({ left: 430, top: 282 });
  expect(
    editorPopoverPosition({
      ...input,
      preferBelow: true,
      anchor: { ...anchor, top: 780, bottom: 804 },
    }),
  ).toEqual({ left: 430, top: 732 });
});

test("uses nearby empty space instead of covering adjacent document text", () => {
  const position = editorPopoverPosition({
    ...input,
    bounds: { ...bounds, right: 1400 },
    avoid: [
      { left: 430, right: 1060, top: 190, bottom: 214 },
      { left: 430, right: 1060, top: 220, bottom: 244 },
      anchor,
      { left: 430, right: 1060, top: 280, bottom: 304 },
    ],
  });
  expect(position).toEqual({ left: 400, top: 142 });
});

test("uses the side gutter when text occupies the available vertical space", () => {
  expect(
    editorPopoverPosition({
      ...input,
      bounds: { ...bounds, right: 1400 },
      avoid: [{ left: 430, right: 1100, top: 120, bottom: 820 }],
    }),
  ).toEqual({ left: 1160, top: 202 });
});

test("declines floating placement when dense text leaves no clear space", () => {
  expect(
    editorPopoverPosition({
      ...input,
      avoid: [{ left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }],
    }),
  ).toBeUndefined();
});
