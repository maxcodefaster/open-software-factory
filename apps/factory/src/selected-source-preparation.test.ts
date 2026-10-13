import { expect, test } from "bun:test";
import { selectedSourcePreparation } from "./selected-source-preparation";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

test("background preparation waits for a stable selection and drops it while browsing Projects", async () => {
  const calls: string[] = [];
  const preparation = selectedSourcePreparation(async (projectID) => {
    calls.push(projectID);
  });
  preparation.select("initial");
  await Bun.sleep(300);
  expect(calls).toEqual([]);
  preparation.select(undefined);
  await Bun.sleep(500);
  expect(calls).toEqual([]);
  preparation.select("chosen");
  await Bun.sleep(800);
  expect(calls).toEqual(["chosen"]);
  preparation.close();
});

test("selected source admission has one running request and only the latest pending Project", async () => {
  const first = Promise.withResolvers<void>();
  const calls: string[] = [];
  const preparation = selectedSourcePreparation(async (projectID) => {
    calls.push(projectID);
    if (projectID === "a") await first.promise;
  }, 0);
  preparation.select("a");
  await tick();
  for (const projectID of ["b", "c", "d"]) preparation.select(projectID);
  await tick();
  expect(calls).toEqual(["a"]);
  first.resolve();
  await tick();
  expect(calls).toEqual(["a", "d"]);
  preparation.select("d");
  await tick();
  expect(calls).toHaveLength(2);
  preparation.close();
});

test("revocation or teardown discards pending preparation, and failures permit later selection", async () => {
  const first = Promise.withResolvers<void>();
  const calls: string[] = [];
  const preparation = selectedSourcePreparation(async (projectID) => {
    calls.push(projectID);
    if (projectID === "a") await first.promise;
    throw new Error("Denied");
  }, 0);
  preparation.select("a");
  await tick();
  preparation.select("b");
  preparation.select(undefined);
  first.resolve();
  await tick();
  expect(calls).toEqual(["a"]);
  preparation.select("c");
  await tick();
  expect(calls).toEqual(["a", "c"]);
  preparation.select("d");
  preparation.close();
  await tick();
  expect(calls).toHaveLength(2);
});
