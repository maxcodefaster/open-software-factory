import { expect, test } from "bun:test";
import { composerKeyDown, followConversation } from "./assistant-interaction";

function key(input: {
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  disabled?: boolean;
  text?: string;
}) {
  let sent = 0;
  let prevented = false;
  composerKeyDown({
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
    ...input,
    preventDefault() {
      prevented = true;
    },
    currentTarget: {
      disabled: false,
      value: input.text ?? "A question",
      form: {
        querySelector() {
          return { disabled: input.disabled ?? false };
        },
        requestSubmit() {
          sent++;
        },
      },
    },
  } as unknown as KeyboardEvent);
  return { sent, prevented };
}

test("Enter sends once, while multiline and IME Enter remain native", () => {
  expect(key({})).toEqual({ sent: 1, prevented: true });
  for (const value of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }])
    expect(key(value)).toEqual({ sent: 0, prevented: false });
});
test("disabled or blank messages cannot be submitted by Enter", () => {
  expect(key({ disabled: true }).sent).toBe(0);
  expect(key({ text: "  " }).sent).toBe(0);
});

test("layout scrolling keeps following, while a reader scrolling up stays put", () => {
  const original = {
    MutationObserver: globalThis.MutationObserver,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  let update = () => {};
  let frame = () => {};
  class Observer {
    constructor(callback: () => void) {
      update = callback;
    }
    observe() {}
    disconnect() {}
  }
  Object.assign(globalThis, {
    MutationObserver: Observer,
    ResizeObserver: Observer,
    requestAnimationFrame: (callback: () => void) => {
      frame = callback;
      return 1;
    },
    cancelAnimationFrame: () => {},
  });
  const listeners = new Map<string, (event: object) => void>();
  const element = {
    scrollHeight: 1000,
    scrollTop: 800,
    clientHeight: 200,
    addEventListener(name: string, callback: (event: object) => void) {
      listeners.set(name, callback);
    },
    removeEventListener(name: string) {
      listeners.delete(name);
    },
  };
  const emit = (name: string, event = {}) => listeners.get(name)?.(event);
  let follower: ReturnType<typeof followConversation> | undefined;
  try {
    follower = followConversation(element as unknown as HTMLDivElement);
    // Answered questions collapse before the next animation frame. A layout
    // scroll event is not a request from the reader to stop following.
    element.scrollTop = 400;
    emit("scroll");
    element.scrollHeight = 1200;
    update();
    frame();
    expect(element.scrollTop).toBe(1200);
    emit("wheel", { deltaY: -100 });
    element.scrollTop = 300;
    emit("scroll");
    element.scrollHeight = 1400;
    update();
    frame();
    expect(element.scrollTop).toBe(300);
    element.scrollTop = 1200;
    emit("scroll");
    element.scrollHeight = 1600;
    update();
    frame();
    expect(element.scrollTop).toBe(1600);
    follower.dispose();
    expect(listeners.size).toBe(0);
  } finally {
    follower?.dispose();
    Object.assign(globalThis, original);
  }
});
