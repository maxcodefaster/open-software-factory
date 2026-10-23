import { expect, test } from "bun:test";
import {
  mcpDefinition,
  recommendedMCPs,
  resolveMCPChoice,
  validateMCPSelection,
  type MCPChoice,
} from "./mcp-library";

test("MCP definitions accept only remote HTTPS without credential-bearing URLs", () => {
  for (const definition of recommendedMCPs)
    expect(mcpDefinition.safeParse(definition).success).toBe(true);
  for (const endpoint of [
    "http://example.com/mcp",
    "file:///tmp/mcp",
    "https://user:secret@example.com/mcp",
    "https://example.com/mcp?access_token=secret",
    "https://example.com/mcp#secret",
  ])
    expect(mcpDefinition.safeParse({ ...recommendedMCPs[0], endpoint }).success).toBe(false);
});

test("MCP choices inherit per entry and role without overriding required policy", () => {
  const libraryId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const base: MCPChoice = {
    libraryId,
    revisionId,
    role: "build",
    scope: "system",
    state: "enable",
    version: 1,
  };
  const project: MCPChoice = { ...base, scope: "project", state: "disable" };
  const personal: MCPChoice = { ...base, scope: "personal", state: "enable" };
  expect(resolveMCPChoice([base, project, personal], libraryId, "build")?.scope).toBe("personal");
  expect(resolveMCPChoice([base, project, personal], libraryId, "build", false)?.state).toBe(
    "disable",
  );
  expect(
    resolveMCPChoice([{ ...base, state: "required" }, project, personal], libraryId, "build")
      ?.scope,
  ).toBe("system");
  expect(resolveMCPChoice([base], libraryId, "planning")).toBeUndefined();
  expect(resolveMCPChoice([base], crypto.randomUUID(), "build")).toBeUndefined();
});

test("read-only approval binds exact tool schemas and does not trust hints", () => {
  const tool = {
    name: "read",
    description: "Read",
    inputSchema: { type: "object" as const },
    digest: "a".repeat(64),
    readOnlyHint: false,
  };
  expect(() =>
    validateMCPSelection([tool], [{ name: tool.name, digest: tool.digest }]),
  ).not.toThrow();
  expect(() => validateMCPSelection([tool], [])).toThrow();
  expect(() =>
    validateMCPSelection([tool], [{ name: tool.name, digest: "b".repeat(64) }]),
  ).toThrow();
  expect(() => validateMCPSelection([tool], [{ name: "write", digest: tool.digest }])).toThrow();
  expect(() => validateMCPSelection([tool], [tool, tool])).toThrow();
});
