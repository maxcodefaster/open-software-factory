import assert from "node:assert/strict";
import { createRoot, createSignal, flush } from "solid-js";
import {
  createDesktopNavigation,
  unavailableLink,
} from "../../apps/factory/src/navigation/desktop";
import {
  type FactoryLocation,
  factoryLocation,
  factoryPath,
} from "../../apps/factory/src/navigation/location";
import { createWorkspaceState } from "../../apps/factory/src/workspace/state";
import { fixtureValue } from "./value";

const projectID = "00000000-0000-4000-8000-000000000001";
const ticketID = "00000000-0000-4000-8000-000000000002";
const ticket = { view: "ticket", projectID, ticketID } as const;
const ticketPath = factoryPath(ticket);
const tick = async () => {
  flush();
  await Promise.resolve();
  flush();
};

const stop = createRoot((dispose) => {
  const [path, setPath] = createSignal(ticketPath);
  const [ready, setReady] = createSignal(false);
  const [access, setAccess] = createSignal("allowed");
  const calls: FactoryLocation[] = [];
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const currents: (() => boolean)[] = [];
  const coordinator = createDesktopNavigation({
    navigation: {
      path,
      location: () => factoryLocation(path()),
      failure: () => "",
      retry() {},
      open(destination) {
        setPath(factoryPath(destination));
      },
    },
    ready,
    accessKey: access,
    apply(destination, current) {
      calls.push(destination);
      currents.push(current);
      // Publication from synchronous restore must not replace the target URL.
      coordinator.publish({ view: "home" });
      if (access() !== "allowed") throw new Error("forbidden");
      if (destination.view === "unavailable") throw new Error("missing");
      return gates.get(factoryPath(destination))?.promise;
    },
  });
  return { dispose, path, setPath, setReady, setAccess, calls, gates, currents, coordinator };
});

await tick();
assert.equal(stop.calls.length, 0);
stop.setReady(true);
await tick();
assert.deepEqual(stop.calls, [ticket]);
assert.equal(stop.path(), ticketPath);
assert.equal(stop.coordinator.pending(), false);
stop.setReady(false);
stop.setAccess("projection temporarily unknown");
await tick();
stop.setReady(true);
stop.setAccess("allowed");
await tick();
assert.equal(stop.calls.length, 1, "cache recovery must not replay the route over a local draft");
stop.coordinator.publish({ view: "inbox" });
await tick();
assert.equal(stop.calls.length, 1, "an already-applied internal selection is not replayed");
stop.setPath(ticketPath);
await tick();
assert.equal(stop.calls.length, 2, "Back restores the Ticket");
stop.coordinator.publish(ticket); // already at this path
stop.setPath("/inbox");
await tick();
stop.setPath(ticketPath);
await tick();
assert.equal(stop.calls.length, 4, "same-path publication cannot swallow a later Back");

stop.setAccess("revoked");
await tick();
assert.equal(stop.coordinator.failure(), unavailableLink);
stop.setAccess("allowed");
await tick();
assert.equal(stop.coordinator.failure(), "");
stop.setPath("/missing");
await tick();
assert.equal(stop.coordinator.failure(), unavailableLink);
const attempts = stop.calls.length;
stop.coordinator.retry();
await tick();
assert.equal(stop.calls.length, attempts + 1);

const gate = Promise.withResolvers<void>();
stop.gates.set(ticketPath, gate);
stop.setPath(ticketPath);
await tick();
assert.equal(stop.coordinator.pending(), true);
const current = fixtureValue(stop.currents.at(-1), "stop.currents.at(-1)");
stop.coordinator.publish({ view: "settings" });
await tick();
assert.equal(current(), false, "internal navigation fences an older read");
gate.reject(new Error("late read failed"));
await tick();
assert.equal(stop.coordinator.failure(), "");
assert.equal(stop.coordinator.pending(), false);

stop.gates.set(ticketPath, Promise.withResolvers<void>());
stop.setPath(ticketPath);
await tick();
const disposedRead = fixtureValue(stop.currents.at(-1), "stop.currents.at(-1)");
stop.dispose();
assert.equal(disposedRead(), false);

createRoot((dispose) => {
  const [project, setProject] = createSignal<string | undefined>(projectID);
  const workspaces = createWorkspaceState(project);
  const draft = { id: "draft", view: "ticket-draft", label: "Keep my writing" } as const;
  workspaces.open(draft);
  flush();
  workspaces.open({ id: "ticket", view: "ticket", label: "Shared Ticket", ticketID });
  flush();
  setProject("another-project");
  flush();
  assert.equal(workspaces.tabs().length, 0);
  workspaces.open({ id: "wiki", view: "knowledge", label: "Wiki" });
  flush();
  setProject(projectID);
  flush();
  assert.deepEqual(
    workspaces.tabs().map((tab) => tab.id),
    ["draft", "ticket"],
  );
  workspaces.close("ticket");
  flush();
  assert.equal(workspaces.current()?.activeTabID, draft.id);
  assert.equal(workspaces.tabs()[0]?.label, "Keep my writing");
  workspaces.close("does-not-exist");
  assert.equal(workspaces.tabs().length, 1);
  setProject("another-project");
  flush();
  assert.equal(workspaces.tabs()[0]?.id, "wiki");
  dispose();
});
console.log("desktop navigation passed");
