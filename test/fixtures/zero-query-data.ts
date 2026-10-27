import assert from "node:assert/strict";
import { createEffect, createRoot, createSignal, flush } from "solid-js";
import { createQueryData } from "../../packages/zero-solid/src/query-data";
import { createQuerySelection } from "../../packages/zero-solid/src/query-selection";
import { addContextToQuery, asQueryInternals } from "@rocicorp/zero/bindings";
import { zeroQueries } from "../../packages/zero-schema/src";

createRoot((dispose) => {
  const state = createQueryData<{ id: string; title: string }[]>();
  state.publish(
    [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ],
    ["id"],
  );
  const second = state.data()?.[1];
  assert.ok(second);
  let runs = 0;
  createEffect(
    () => state.data()?.[1]?.title,
    () => {
      runs++;
    },
  );
  flush();
  assert.equal(runs, 1);
  state.publish(
    [
      { id: "a", title: "Changed" },
      { id: "b", title: "B" },
    ],
    ["id"],
  );
  flush();
  assert.equal(state.data()?.[0]?.title, "Changed");
  assert.equal(state.data()?.[1], second);
  assert.equal(runs, 1);
  console.log(`unchangedRowEffects=${runs}`);
  dispose();
});

createRoot((dispose) => {
  const [noise, setNoise] = createSignal(0);
  const [project, setProject] = createSignal("00000000-0000-4000-8000-000000000001");
  const [client, setClient] = createSignal({});
  const query = createQuerySelection(() => {
    noise();
    const resolved = addContextToQuery(
      zeroQueries.tickets.active({ projectId: project(), limit: 201 }),
      { userId: "00000000-0000-4000-8000-000000000002" },
    );
    const internals = asQueryInternals(resolved);
    return {
      client: client(),
      query: resolved,
      key: `${internals.hash()}:${JSON.stringify(internals.format)}`,
    };
  });
  let subscriptions = 0;
  createEffect(query, () => {
    subscriptions++;
  });
  flush();
  const original = query();
  setNoise(1);
  flush();
  assert.equal(query(), original);
  assert.equal(subscriptions, 1);
  console.log(`sameQuerySubscriptions=${subscriptions}`);
  setProject("00000000-0000-4000-8000-000000000003");
  flush();
  assert.equal(subscriptions, 2);
  setClient({});
  flush();
  assert.equal(subscriptions, 3);
  dispose();
});

createRoot((dispose) => {
  const state = createQueryData<{ projectId: string; userId: string; role: string }[]>();
  const a = { projectId: "one", userId: "person", role: "developer" };
  const b = { projectId: "two", userId: "person", role: "product-contributor" };
  state.publish([a, b], ["projectId", "userId"]);
  state.publish([b, { ...a, role: "product-contributor" }], ["projectId", "userId"]);
  assert.equal(state.data()?.[0]?.projectId, "two");
  assert.equal(state.data()?.[1]?.projectId, "one");
  assert.equal(state.data()?.[1]?.role, "product-contributor");
  console.log("compoundKeys=correct");
  dispose();
});
