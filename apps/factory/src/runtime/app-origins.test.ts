import { expect, test } from "bun:test";
import { appRuntimeOrigin } from "../runtime-origins";
import { runtimeAppOrigins, runtimePublicFactoryOrigin } from "./app-origins";

const attemptID = "01234567-89ab-5def-8123-456789abcdef";
const contract = {
  version: 1 as const,
  primaryApp: "web",
  apps: [
    { id: "web", label: "Website", command: ["node", "web.js"], port: 4321, healthPath: "/" },
    {
      id: "forms-admin",
      label: "Editor",
      command: ["node", "admin.js"],
      port: 3002,
      healthPath: "/",
    },
  ],
};

test("App process addresses bind declared ports to the same origins the browser uses", () => {
  for (const origin of ["http://127.0.0.1:58510", "https://factory.example"]) {
    expect(runtimeAppOrigins(origin, attemptID, contract)).toEqual({
      "4321": appRuntimeOrigin(origin, attemptID, "app"),
      "3002": appRuntimeOrigin(origin, attemptID, "app-forms-admin"),
    });
  }
  expect(runtimeAppOrigins(null, attemptID, contract)).toBeUndefined();
  expect(runtimePublicFactoryOrigin(undefined)).toBeNull();
});

test.each([
  "file:///tmp/factory",
  "https://factory.example/path",
  "https://actor:secret@factory.example",
  "https://factory.example?token=owned",
  "https://factory.example#fragment",
  "not-an-origin",
])("App publication rejects a non-origin declaration %s", (origin) => {
  expect(() => runtimePublicFactoryOrigin(origin)).toThrow();
});
