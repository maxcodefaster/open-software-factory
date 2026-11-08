type Pointer = Pick<
  PointerEvent,
  "pointerId" | "pointerType" | "isPrimary" | "button" | "clientX" | "clientY"
>;

/** Keep a touch tap bound to its original tree identity, even if focus redraws the row. */
export function treeTouchGesture() {
  let pressed: { pointerID: number; nodeID: string; x: number; y: number } | undefined;
  return {
    down(event: Pointer, nodeID: string) {
      pressed =
        event.pointerType === "touch" && event.isPrimary && event.button === 0
          ? { pointerID: event.pointerId, nodeID, x: event.clientX, y: event.clientY }
          : undefined;
    },
    up(event: Pointer) {
      const original = pressed;
      pressed = undefined;
      if (
        !original ||
        event.pointerType !== "touch" ||
        !event.isPrimary ||
        event.pointerId !== original.pointerID ||
        Math.hypot(event.clientX - original.x, event.clientY - original.y) > 10
      )
        return undefined;
      return original.nodeID;
    },
    cancel() {
      pressed = undefined;
    },
  };
}

export function isTreeTouchClick(event: Event) {
  const native = event as Event & {
    pointerType?: string;
    sourceCapabilities?: { firesTouchEvents?: boolean };
  };
  return native.pointerType === "touch" || native.sourceCapabilities?.firesTouchEvents === true;
}
