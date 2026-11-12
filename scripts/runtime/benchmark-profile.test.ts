import { describe, expect, test } from "bun:test";
import {
  benchmarkCommandKind,
  benchmarkMemoryMiB,
  factoryboxExecutable,
  profiledArguments,
} from "./benchmark-profile";

describe("optional lifecycle profiling", () => {
  const command = [
    "kubectl",
    "--context",
    "test",
    "exec",
    "owned-pod",
    "--",
    factoryboxExecutable,
    "--worker-store-id",
    "original-store",
    "--worker-epoch",
    "original-epoch",
    "pause",
    "--snapshot-id",
    "original-snapshot",
    "owned-sandbox",
  ];

  test("disabled mode preserves the complete original invocation", () => {
    expect(profiledArguments(command, false)).toEqual(command);
  });

  test("only the native worker invocation receives the explicit trace flag", () => {
    const result = profiledArguments(command, true);
    expect(result).toEqual([
      ...command.slice(0, 6),
      "env",
      "FACTORYBOX_TRACE_PHASES=1",
      ...command.slice(6),
    ]);
    expect(command[6]).toBe(factoryboxExecutable);
    for (const args of [
      ["kubectl", "get", "pod", "owned-pod"],
      ["kubectl", "exec", "owned-pod", "--", "python3", "-c", "private input"],
      [factoryboxExecutable, "pause", "owned-sandbox"],
    ])
      expect(profiledArguments(args, true)).toEqual(args);
  });

  test("command labels contain no identities or request contents", () => {
    expect(benchmarkCommandKind(command)).toBe("factorybox:pause");
    expect(benchmarkCommandKind(["kubectl", "get", "secret", "private-name"])).toBe(
      "kubernetes:get",
    );
    expect(benchmarkCommandKind(["kubectl", "exec", "pod", "--", "python3", "secret"])).toBe(
      "kubernetes:exec",
    );
  });

  test("memory workload defaults remain unchanged and larger fixtures are bounded", () => {
    expect(benchmarkMemoryMiB(undefined)).toBe(256);
    expect(benchmarkMemoryMiB("1024")).toBe(1024);
    for (const value of ["0", "63", "1537", "NaN", "256.5"])
      expect(() => benchmarkMemoryMiB(value)).toThrow();
  });
});
