import { expect, test } from "bun:test";
import { markdownHTML } from "../markdown";
import { attachmentText, readAttachmentContent, restoreAttachmentContent } from "./composer";
import {
  chooseMention,
  mentionEndingAt,
  readableMentions,
  serializeMentions,
} from "./mention-text";

const owner = () => Object.assign(new EventTarget(), { value: "" }) as HTMLTextAreaElement;

test("a chosen mention reads as @Name in the composer and serializes to the exact link", () => {
  const input = owner();
  const id = crypto.randomUUID();
  input.value = `Please check ${chooseMention({ id, name: "Tom Development" }, input)} now.`;
  expect(input.value).toBe("Please check @Tom Development now.");
  expect(readAttachmentContent(input)).toBe(
    `Please check [@Tom Development](factory-person:${id}) now.`,
  );
  // Rendering the stored form is unchanged.
  expect(markdownHTML(readAttachmentContent(input))).toContain("@Tom Development");
});

test("stored links become readable on restore and survive a round trip", () => {
  const input = owner();
  const id = crypto.randomUUID();
  const stored = `Ask [@Lisa Product](factory-person:${id}) and \`[@Lisa Product](factory-person:${id})\`.`;
  restoreAttachmentContent(input, stored);
  expect(input.value).toBe(`Ask @Lisa Product and \`[@Lisa Product](factory-person:${id})\`.`);
  expect(attachmentText(stored)).toBe(input.value);
  expect(readAttachmentContent(input)).toBe(stored);
});

test("typed names that were never chosen, partial names and code stay literal", () => {
  const input = owner();
  const id = crypto.randomUUID();
  chooseMention({ id, name: "Max Mustermann" }, input);
  expect(serializeMentions("@Someone else", input)).toBe("@Someone else");
  expect(serializeMentions("@Max Mustermanns", input)).toBe("@Max Mustermanns");
  expect(serializeMentions("mail@Max Mustermann", input)).toBe("mail@Max Mustermann");
  expect(serializeMentions("`@Max Mustermann`", input)).toBe("`@Max Mustermann`");
  expect(serializeMentions("Hi @Max Mustermann!", input)).toBe(
    `Hi [@Max Mustermann](factory-person:${id})!`,
  );
});

test("two people with one name follow the order they were chosen in", () => {
  const input = owner();
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const label = "Sam Twin";
  chooseMention({ id: first, name: label }, input);
  chooseMention({ id: second, name: label }, input);
  expect(serializeMentions("@Sam Twin and @Sam Twin", input)).toBe(
    `[@Sam Twin](factory-person:${first}) and [@Sam Twin](factory-person:${second})`,
  );
  // Without a recorded order a shared name is never guessed.
  expect(serializeMentions("@Sam Twin", owner())).toBe("@Sam Twin");
});

test("a mention ending at the caret is removed as one unit", () => {
  const id = crypto.randomUUID();
  chooseMention({ id, name: "Ina Atomic" }, owner());
  const text = "Hello @Ina Atomic";
  expect(mentionEndingAt(text, text.length)).toBe("@Ina Atomic".length);
  expect(mentionEndingAt("Hello @Ina Atomic ", "Hello @Ina Atomic ".length)).toBe(0);
  expect(mentionEndingAt("x@Ina Atomic", "x@Ina Atomic".length)).toBe(0);
  expect(readableMentions("no links")).toBe("no links");
});
