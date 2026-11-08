import { expect, test } from "bun:test";
import {
  isTreeTouchClick,
  treeTouchGesture,
} from "../../../deploy/theia-ide/factory-ide-extension/src/browser/factory-tree-touch";

const pointer = {
  pointerId: 1,
  pointerType: "touch",
  isPrimary: true,
  button: 0,
  clientX: 12,
  clientY: 24,
};
test("a primary touch tap preserves the original tree node and activates once", () => {
  const gesture = treeTouchGesture();
  gesture.down(pointer, "factory-workspace://owned/package.json");
  expect(gesture.up({ ...pointer, clientX: 14 })).toBe("factory-workspace://owned/package.json");
  expect(gesture.up(pointer)).toBeUndefined();
});
test("tree scrolling, cancellation, another pointer and non-primary input do not open a file", () => {
  for (const changed of [
    { clientY: 40 },
    { pointerId: 2 },
    { isPrimary: false },
    { pointerType: "mouse" },
  ]) {
    const gesture = treeTouchGesture();
    gesture.down(pointer, "original");
    expect(gesture.up({ ...pointer, ...changed })).toBeUndefined();
  }
  const gesture = treeTouchGesture();
  gesture.down(pointer, "original");
  gesture.cancel();
  expect(gesture.up(pointer)).toBeUndefined();
});
test("compatibility touch clicks are distinct from mouse and keyboard clicks", () => {
  expect(isTreeTouchClick({ pointerType: "touch" } as unknown as Event)).toBe(true);
  expect(
    isTreeTouchClick({ sourceCapabilities: { firesTouchEvents: true } } as unknown as Event),
  ).toBe(true);
  expect(isTreeTouchClick({ pointerType: "mouse" } as unknown as Event)).toBe(false);
  expect(isTreeTouchClick({} as Event)).toBe(false);
});
