import { describe, expect, test } from "bun:test";
import { canTransitionRoleProbe } from "./connection-probes";
import { canTransitionConnectionWrite } from "./connection-writes";

describe("model connection write and role probe state machines", () => {
  test("connection write phase transitions strictly write-intended -> committed", () => {
    expect(canTransitionConnectionWrite("write-intended", "committed")).toBe(true);
    expect(canTransitionConnectionWrite("write-intended", "write-intended")).toBe(false);
    expect(canTransitionConnectionWrite("committed", "write-intended")).toBe(false);
    expect(canTransitionConnectionWrite("committed", "committed")).toBe(false);
  });

  test("role probe phase transitions strictly probing -> finished | uncertain", () => {
    expect(canTransitionRoleProbe("probing", "finished")).toBe(true);
    expect(canTransitionRoleProbe("probing", "uncertain")).toBe(true);
    expect(canTransitionRoleProbe("probing", "probing")).toBe(false);
    expect(canTransitionRoleProbe("finished", "probing")).toBe(false);
    expect(canTransitionRoleProbe("finished", "uncertain")).toBe(false);
    expect(canTransitionRoleProbe("uncertain", "finished")).toBe(false);
  });
});
