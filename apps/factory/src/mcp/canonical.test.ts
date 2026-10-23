import { expect, test } from "bun:test";
import { canonicalMCPJSON, mcpDigest } from "./controller";

test("MCP fingerprints survive JSONB and OpenBao key ordering without losing array order", () => {
  const material = {
    verifier: "owned",
    tokens: { token_type: "Bearer", access_token: "owned", scope: ["read", "inspect"] },
  };
  const stored = {
    tokens: { scope: ["read", "inspect"], access_token: "owned", token_type: "Bearer" },
    verifier: "owned",
  };
  expect(canonicalMCPJSON(material)).toBe(canonicalMCPJSON(stored));
  expect(mcpDigest(material)).toBe(mcpDigest(stored));
  expect(mcpDigest(material)).not.toBe(
    mcpDigest({ ...stored, tokens: { ...stored.tokens, scope: ["inspect", "read"] } }),
  );
  expect(canonicalMCPJSON({ omitted: undefined, value: [undefined, null] })).toBe(
    '{"value":[null,null]}',
  );
});
