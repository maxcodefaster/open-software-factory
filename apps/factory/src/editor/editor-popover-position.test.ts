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

test("keeps expanded link controls at the selection instead of a separate header", () => {
  expect(
    editorPopoverPosition({
      ...input,
      width: 384,
      height: 100,
      align: "start",
    }),
  ).toEqual({ left: 430, top: 142 });
});

test("clamps expanded controls to a narrow viewport and flips below the selection", () => {
  expect(
    editorPopoverPosition({
      ...input,
      bounds: { left: 20, top: 120, right: 370, bottom: 820 },
      anchor: { left: 270, right: 320, top: 155, bottom: 178 },
      width: 384,
      height: 100,
    }),
  ).toEqual({ left: 20, top: 186 });
});
