import { describe, expect, test } from "bun:test";
import { parseSystemContract, primarySystemApp, SystemContractError } from "./system-contract";

const validApp = {
  id: "web",
  label: "Web",
  command: ["node", "src/server.mjs"],
  port: 4_300,
  healthPath: "/health",
};
const valid = {
  version: 1,
  primaryApp: "web",
  apps: [validApp],
};

describe("System Contract", () => {
  test("selects one bounded primary App", () => {
    const contract = parseSystemContract(JSON.stringify(valid));
    expect(primarySystemApp(contract)).toEqual(validApp);
  });

  test("rejects shell strings, unknown fields, and duplicate ports", () => {
    for (const value of [
      { ...valid, apps: [{ ...validApp, command: "node src/server.mjs" }] },
      { ...valid, apps: [{ ...validApp, command: ["sh", "-c", "node src/server.mjs"] }] },
      { ...valid, resources: { memory: "2Gi" } },
      {
        ...valid,
        apps: [...valid.apps, { ...validApp, id: "worker" }],
      },
    ]) {
      expect(() => parseSystemContract(JSON.stringify(value))).toThrow(SystemContractError);
    }
  });

  test("rejects a primary App that is not declared", () => {
    expect(() => parseSystemContract(JSON.stringify({ ...valid, primaryApp: "api" }))).toThrow(
      "Primary App must name one declared App",
    );
  });
});
