import { z } from "zod";
import { createOpenBaoKV, type OpenBaoOptions } from "../secrets/openbao";

export const mcpSecret = z
  .object({
    connectionId: z.uuid(),
    commandId: z.uuid(),
    digest: z.string(),
    material: z.record(z.string(), z.unknown()),
  })
  .strict();
export type MCPSecret = z.infer<typeof mcpSecret>;
export type MCPSecrets = {
  configured: boolean;
  read(key: string): Promise<MCPSecret | undefined>;
  create(key: string, value: MCPSecret): Promise<void>;
};
export function createMCPSecrets(options?: OpenBaoOptions): MCPSecrets {
  const store = createOpenBaoKV(options);
  function validate(key: string) {
    if (!/^mcp\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key))
      throw new Error("Invalid MCP credential identity");
    return key;
  }
  return {
    configured: store.configured,
    read: (key) => store.read(validate(key), mcpSecret),
    create: (key, value) => store.create(validate(key), value, mcpSecret),
  };
}
