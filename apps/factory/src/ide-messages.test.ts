import { describe, expect, test } from "bun:test";
import { developmentPreviewMessage } from "./ide-messages";
import { openFactoryPreview } from "../../../deploy/theia-ide/factory-ide-extension/src/browser/factory-runtime-context";

const attemptID = "01994a7d-0000-7000-8000-000000000001";
const workspaceID = "01994a7d-0000-7000-8000-000000000002";

describe("IDE messages", () => {
  test("uses the authenticated independent-editor origin even after reload suppresses referrer", async () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    const targets: string[] = [];
    const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: `http://user.1.h3000.editor.runtime.localhost:3000/editor/${attemptID}/1/`,
        },
        parent: { postMessage: (_message: unknown, target: string) => targets.push(target) },
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { referrer: "" },
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async () => Response.json({ factoryOrigin: "http://127.0.0.1:3000" }),
    });
    try {
      await openFactoryPreview({ workspaceID, attemptID }, "app-worker", "Worker monitor");
      expect(targets).toEqual(["http://127.0.0.1:3000"]);
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
      else Reflect.deleteProperty(globalThis, "window");
      if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
      else Reflect.deleteProperty(globalThis, "document");
      if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor);
    }
  });
  test("accepts only the narrow development Preview message", () => {
    expect(
      developmentPreviewMessage({
        type: "factory:open-development-preview",
        attemptID,
        workspaceID,
        process: "app-worker",
        label: "Worker monitor",
      }),
    ).toEqual({
      type: "factory:open-development-preview",
      attemptID,
      workspaceID,
      process: "app-worker",
      label: "Worker monitor",
    });
    expect(
      developmentPreviewMessage({
        type: "factory:open-development-preview",
        attemptID,
        workspaceID,
        process: "ide",
        label: "IDE",
      }),
    ).toBeUndefined();
  });

  test("requires the exact source Workspace as well as the execution Attempt", () => {
    expect(
      developmentPreviewMessage({
        type: "factory:open-development-preview",
        attemptID,
        process: "app",
        label: "App",
      }),
    ).toBeUndefined();
  });
});
