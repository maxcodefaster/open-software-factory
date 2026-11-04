import { expect, test } from "bun:test";
import {
  mcpDefinition,
  mcpSaveContent,
  publicMCPAddress,
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

test("new MCP definitions must name a public host on port 443", () => {
  for (const definition of recommendedMCPs)
    expect(mcpSaveContent.safeParse(definition).success).toBe(true);
  for (const endpoint of [
    "https://localhost/mcp",
    "https://tools.localhost/mcp",
    "https://intranet/mcp",
    "https://printer.local/mcp",
    "https://wiki.internal/mcp",
    "https://127.0.0.1/mcp",
    "https://10.0.0.5/mcp",
    "https://[::1]/mcp",
    "https://example.com:8443/mcp",
  ]) {
    const result = mcpSaveContent.safeParse({ ...recommendedMCPs[0], endpoint });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("public HTTPS endpoint");
  }
  for (const endpoint of ["https://mcp.example.com/mcp", "https://1.1.1.1/mcp"])
    expect(mcpSaveContent.safeParse({ ...recommendedMCPs[0], endpoint }).success).toBe(true);
  expect(publicMCPAddress("8.8.8.8")).toBe(true);
  expect(publicMCPAddress("999.1.1.1")).toBe(false);
  expect(publicMCPAddress("example.com")).toBe(false);
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
