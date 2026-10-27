import { expect, test } from "bun:test";
import { readProjectImageSnapshots } from "../fixtures/runtime-cache-observation";

test("cache diagnostics serialize native worker observations and retain each exact image reference", async () => {
  let reading = false;
  const calls: string[] = [];
  const first = "registry.invalid/first@sha256:a";
  const second = "registry.invalid/second@sha256:b";
  const references = [first, second];
  const result = await readProjectImageSnapshots(references, async (reference) => {
    if (reading) throw new Error("Overlapping native worker observations");
    reading = true;
    calls.push(reference);
    await Bun.sleep(0);
    reading = false;
    return { id: reference.slice(-1), digests: [reference] };
  });
  expect(calls).toEqual(references);
  expect(result).toEqual([
    { reference: first, id: "a", digests: [first] },
    { reference: second, id: "b", digests: [second] },
  ]);
});
