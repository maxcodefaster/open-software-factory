import { expect, test } from "bun:test";
import { FactoryWriteContext } from "../../deploy/theia-ide/factory-ide-extension/src/browser/factory-write-context";

test("Theia process controls fail closed and ignore stale Workspace writer responses", () => {
  const context = new FactoryWriteContext();
  let updates = 0;
  const subscription = context.subscribe(() => updates++);
  expect(context.allows("first")).toBe(false);
  context.select("first");
  context.confirm("first", true);
  expect(context.allows("first")).toBe(true);
  context.select("second");
  context.confirm("first", true);
  expect(context.allows("first")).toBe(false);
  expect(context.allows("second")).toBe(false);
  context.confirm("second", true);
  expect(context.allows("second")).toBe(true);
  context.confirm("second", false);
  expect(context.allows("second")).toBe(false);
  expect(updates).toBe(5);
  subscription.dispose();
  context.select(undefined);
  expect(updates).toBe(5);
});
