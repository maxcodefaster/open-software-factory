import { expect, test } from "bun:test";
import { previewBridge } from "./preview-bridge";
import { createBridgeSession } from "./preview-bridge-state";

test("bridge session state machine transitions across disconnected, waiting, selected, attached, failed, and disposed", () => {
  const session = createBridgeSession("/home");
  expect(session.phase()).toEqual({ kind: "disconnected" });
  expect(session.isActive()).toBe(false);
  expect(session.token()).toBe("");

  const fakeEl = {} as Element;
  const waiting = session.enterSelect("tok-1", "element", fakeEl);
  expect(waiting).toEqual({ kind: "waiting", token: "tok-1", selected: fakeEl });
  expect(session.isActive()).toBe(true);
  expect(session.isWaiting()).toBe(true);
  expect(session.matchesParent("tok-1", session.documentId())).toBe(true);
  expect(session.matchesParent("wrong", session.documentId())).toBe(false);

  const selected = session.choose(fakeEl, "sel-1");
  expect(selected).toEqual({
    kind: "selected",
    token: "tok-1",
    selectionId: "sel-1",
    selected: fakeEl,
  });
  expect(session.isActive()).toBe(true);
  expect(session.isWaiting()).toBe(false);
  expect(session.isSelectionCurrent("sel-1", "tok-1")).toBe(true);

  const prevDoc = session.documentId();
  session.setPins([
    { id: "fb-1", selector: "#btn", label: "1", element: "Save button" },
    { id: 123, selector: "#bad" },
  ]);
  expect(session.pins()).toHaveLength(1);
  expect(session.invalidate("/next")).toBe(true);
  expect(session.documentId()).not.toBe(prevDoc);
  expect(session.page()).toBe("/next");
  expect(session.pins()).toEqual([]);
  expect(session.isSelectionCurrent("sel-1", "tok-1")).toBe(false);

  expect(session.cancel()).toEqual({ kind: "attached", token: "tok-1" });
  expect(session.isActive()).toBe(false);

  expect(session.fail("renderer blocked")).toEqual({
    kind: "failed",
    token: "tok-1",
    reason: "renderer blocked",
  });

  expect(session.dispose()).toEqual({ kind: "disposed" });
  expect(session.token()).toBe("");
  expect(session.enterSelect("tok-2", "element", fakeEl)).toEqual({ kind: "disposed" });
});

test("serialized previewBridge script executes cleanly in isolation without external bindings", () => {
  const script = previewBridge("https://factory.invalid");
  const messages: Array<{ data: Record<string, unknown>; origin: string }> = [];
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();

  const makeElement = (tag: string) => {
    const children: unknown[] = [];
    const el: Record<string, unknown> = {
      tagName: tag.toUpperCase(),
      dataset: {},
      style: {},
      tabIndex: 0,
      isConnected: false,
      textContent: "",
      children,
      append: (...nodes: unknown[]) => {
        for (const node of nodes) {
          children.push(node);
          if (node && typeof node === "object")
            (node as Record<string, unknown>)["isConnected"] = true;
        }
      },
      replaceChildren: () => {
        children.length = 0;
      },
      setAttribute: () => {},
      getAttribute: () => null,
      contains: (node: unknown) => node === el || children.includes(node),
      focus: () => {},
      matches: () => false,
      closest: () => null,
      getBoundingClientRect: () => ({
        x: 10,
        y: 20,
        width: 100,
        height: 40,
        top: 20,
        right: 110,
        bottom: 60,
      }),
      querySelectorAll: () => [],
    };
    return el;
  };

  const docEl = makeElement("html");
  const body = makeElement("body");
  const fakeParent = {
    postMessage: (data: Record<string, unknown>, origin: string) => messages.push({ data, origin }),
  };
  const fakeWindow = Object.assign(windowTarget, {
    parent: fakeParent,
    location: { pathname: "/app", origin: "https://app.invalid" },
    innerWidth: 1024,
    innerHeight: 768,
  });
  const fakeDocument = Object.assign(documentTarget, {
    hidden: false,
    currentScript: null,
    documentElement: docEl,
    body,
    head: makeElement("head"),
    createElement: (tag: string) => makeElement(tag),
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
  });
  class FakeMutationObserver {
    observe() {}
  }

  const run = new Function(
    "window",
    "document",
    "parent",
    "location",
    "performance",
    "MutationObserver",
    "CSS",
    "innerWidth",
    "innerHeight",
    script,
  );
  run(
    fakeWindow,
    fakeDocument,
    fakeParent,
    fakeWindow.location,
    { getEntriesByType: () => [{ responseStatus: 200 }] },
    FakeMutationObserver,
    { supports: () => true, escape: (v: string) => v },
    1024,
    768,
  );

  expect(messages).toEqual([
    {
      data: { type: "factory-preview-document-ready", status: 200 },
      origin: "https://factory.invalid",
    },
  ]);

  const selectEvent = Object.assign(new Event("message"), {
    source: fakeParent,
    origin: "https://factory.invalid",
    data: { type: "factory-review-select", token: "tok-abc", mode: "element" },
  });
  windowTarget.dispatchEvent(selectEvent);

  expect(messages).toHaveLength(2);
  expect(messages[1]?.origin).toBe("https://factory.invalid");
  expect(messages[1]?.data["type"]).toBe("factory-review-ready");
  expect(messages[1]?.data["token"]).toBe("tok-abc");
  expect(messages[1]?.data["page"]).toBe("/app");
});
