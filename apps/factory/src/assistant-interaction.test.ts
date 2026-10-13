import { expect, test } from "bun:test";
import { composerKeyDown } from "./assistant-interaction";

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
