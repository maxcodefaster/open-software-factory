import { expect, test } from "bun:test";

async function reactiveQuery(source: string) {
  const child = Bun.spawn(
    [process.execPath, "--conditions=browser", "--no-env-file", "--eval", source],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status) throw new Error(error);
  return output;
}

test("Solid 2 query stores update only changed subscribers and reconcile compound keys", async () => {
  // Bun's default Solid entry is SSR. Exercise the shipped browser reactive
  // engine, not its intentionally non-reactive server stubs.
  const child = Bun.spawn(
    [process.execPath, "--conditions=browser", "--no-env-file", "test/fixtures/zero-query-data.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status) throw new Error(error);
  expect(output).toContain("unchangedRowEffects=1");
  expect(output).toContain("compoundKeys=correct");
  expect(output).toContain("sameQuerySubscriptions=1");
});

test("query eviction rechecks sticky completeness without losing same-page data", async () => {
  const output = await reactiveQuery(`
    import assert from "node:assert/strict";
    import { setTimeout as tick } from "node:timers/promises";
    import { createEffect, createRoot, createSignal, flush } from "solid-js";
    import { ZeroClientLifecycle, ZeroProvider, useZeroQuery } from "./packages/zero-solid/src";
    import { zeroSchema, zql } from "./packages/zero-schema/src/schema";

    const views = [];
    let initialCompleteness = "unknown";
    const client = {
      context: { userId: "reader", systemManager: true },
      schema: zeroSchema,
      materialize() {
        let listener;
        const view = {
          data: undefined,
          addListener(value) {
            listener = value;
            value(view.data, initialCompleteness);
            return () => { listener = undefined; };
          },
          publish(data, completeness) {
            view.data = data;
            listener?.(data, completeness);
          },
          destroy() {},
        };
        views.push(view);
        return view;
      },
      async close() {},
    };
    // Only the native client is replaced. Context, query hashing,
    // materialization subscription and publication run through the real adapter.
    let selectedClient = client;
    ZeroClientLifecycle.prototype.select = (identity) => identity ? selectedClient : undefined;
    await createRoot(async (dispose) => {
      const [identity, setIdentity] = createSignal({ userId: "reader", schemaVersion: "1" });
      const [page, setPage] = createSignal("page");
      let query;
      const provider = ZeroProvider({
        get identity() { return identity(); },
        get children() {
          query = useZeroQuery(() => zql.knowledgePage.where("id", page()).one());
          return null;
        },
      });
      createEffect(provider, () => {});
      flush();
      views[0].publish({ id: "page", currentBody: "Saved human explanation." }, "complete");
      flush();
      assert.equal(query.data()?.id, "page");
      assert.equal(query.completeness(), "complete");
      const original = query.data();
      const visibility = [];
      createEffect(() => Boolean(query.data()), (visible) => { visibility.push(visible); });
      flush();

      // The eviction commit removes rows before invalidating the got-query key.
      // The old native view keeps "complete"; a new view starts "unknown".
      views[0].publish(undefined, "complete");
      await tick(0);
      flush();
      assert.equal(views.length, 2, "eviction re-materializes the stale complete view");
      assert.equal(query.completeness(), "unknown");
      assert.equal(query.data(), original, "same-page unknown generation must not remove its document");
      views[1].publish(undefined, "cached");
      flush();
      assert.equal(query.data(), original, "cached completeness is not confirmed absence");
      views[1].publish({ id: "page", currentBody: "Remote human explanation." }, "complete");
      flush();
      assert.ok(visibility.every(Boolean), "native eviction never removes the same-page document");
      assert.equal(query.data()?.id, "page");
      assert.equal(query.data()?.currentBody, "Remote human explanation.");

      initialCompleteness = "complete";
      views[1].publish(undefined, "complete");
      await tick(0);
      flush();
      assert.equal(views.length, 3);
      assert.equal(query.data(), undefined, "a fresh complete absence removes the document");
      initialCompleteness = "unknown";

      views[2].publish({ id: "page", currentBody: "Saved human explanation." }, "complete");
      flush();
      const saved = query.data();
      query.retry();
      flush();
      assert.equal(views.length, 4);
      assert.equal(query.data(), saved, "explicit same-query retry retains only incomplete data");
      views[3].publish({ id: "page", currentBody: "Saved human explanation." }, "complete");
      flush();
      views[3].publish(undefined, "complete");
      setPage("other-page");
      flush();
      assert.equal(query.data(), undefined, "another query cannot retain the prior page");
      assert.equal(query.completeness(), "unknown");
      await tick(0);
      flush();
      assert.equal(views.length, 5, "navigation cancels the old query's pending confirmation");
      views[4].publish({ id: "other-page", currentBody: "Other page." }, "complete");
      flush();
      selectedClient = { ...client };
      setIdentity({ userId: "replacement", schemaVersion: "1" });
      flush();
      assert.equal(query.data(), undefined, "another client cannot retain authorized data");
      views[5].publish({ id: "other-page", currentBody: "Replacement view." }, "complete");
      flush();
      views[5].publish(undefined, "complete");
      views[5].publish({ id: "other-page", currentBody: "Revoked view." }, "error");
      flush();
      assert.equal(query.data(), undefined, "an errored query cannot retain authorized data");
      assert.equal(query.completeness(), "error");
      await tick(0);
      flush();
      assert.equal(views.length, 6, "authorization failure cancels pending confirmation");
      views[5].publish({ id: "other-page", currentBody: "Replacement view." }, "complete");
      flush();
      views[5].publish(undefined, "complete");
      setIdentity(null);
      flush();
      assert.equal(query.data(), undefined, "removed identity clears authorized data");
      assert.equal(query.completeness(), "unknown");
      await tick(0);
      flush();
      assert.equal(views.length, 6, "identity removal cancels pending confirmation");
      dispose();
      console.log("samePageGenerations=consistent confirmedAbsence=removed identityLoss=cleared");
    });
  `);
  expect(output).toContain("samePageGenerations=consistent");
  expect(output).toContain("confirmedAbsence=removed");
  expect(output).toContain("identityLoss=cleared");
});
