import { z } from "zod";
import { libraryCoverState } from "./library-covers";

export const mcpScope = z.enum(["personal", "project", "system"]);
export const mcpRole = z.enum(["planning", "build"]);
// Public unicast only. The server pins the checked address on the actual TLS request.
export function publicMCPAddress(value: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const [a = 0, b = 0, c = 0, d = 0] = v4.slice(1).map(Number);
    if (a > 255 || b > 255 || c > 255 || d > 255) return false;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Accept global unicast, excluding documentation and transition mechanisms.
  if (!value.includes(":")) return false;
  let ip: string;
  try {
    ip = new URL(`https://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return false;
  }
  const segments = ip.split(":");
  return (
    /^[23]/.test(ip) &&
    !ip.startsWith("2002:") &&
    !ip.startsWith("3fff:") &&
    !(
      segments[0] === "2001" &&
      (Number.parseInt(segments[1] || "0", 16) < 0x200 || segments[1] === "db8")
    )
  );
}

// Stored definitions stay readable; only new saves must name a public host.
function publicMCPHost(value: string) {
  const url = new URL(value);
  if (url.port) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return publicMCPAddress(host);
  return host.includes(".") && !/\.(localhost|local|localdomain|internal|home\.arpa)$/i.test(host);
}

export const mcpEndpoint = z
  .url()
  .max(2048)
  .superRefine((value, context) => {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].some((key) =>
        /token|secret|password|api.?key|authorization/i.test(key),
      )
    )
      context.addIssue({
        code: "custom",
        message: "Use an HTTPS endpoint without credentials, secret query parameters or a fragment",
      });
  });
export const mcpDefinition = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2000),
    endpoint: mcpEndpoint,
    provider: z.enum(["custom", "sentry", "datadog"]),
    authentication: z.enum(["oauth", "bearer", "none"]),
    roles: z
      .array(mcpRole)
      .min(1)
      .max(2)
      .refine((roles) => new Set(roles).size === roles.length),
  })
  .strict();
export const mcpTool = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_.-]+$/),
    description: z.string().max(8000),
    inputSchema: z.object({ type: z.literal("object") }).catchall(z.unknown()),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    readOnlyHint: z.boolean(),
  })
  .strict();
export const mcpRevision = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  content: mcpDefinition,
  digest: z.string(),
});
export const mcpSaveContent = mcpDefinition.refine(
  (definition) => publicMCPHost(definition.endpoint),
  {
    path: ["endpoint"],
    message: "Use a public HTTPS endpoint on port 443, not a local or private network address",
  },
);
export const mcpSaveInput = z
  .object({
    libraryId: z.uuid(),
    revisionId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    scope: mcpScope,
    projectId: z.uuid().optional(),
    content: mcpSaveContent,
  })
  .strict();
export const mcpChoiceInput = z
  .object({
    libraryId: z.uuid(),
    revisionId: z.uuid(),
    scope: mcpScope,
    projectId: z.uuid().optional(),
    role: mcpRole,
    state: z.enum(["inherit", "enable", "disable", "required"]),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export const mcpChoice = mcpChoiceInput.omit({ expectedVersion: true, projectId: true }).extend({
  version: z.number().int(),
});
export const mcpConnectionView = z.object({
  id: z.uuid(),
  revisionId: z.uuid(),
  state: z.enum(["disconnected", "authorizing", "review", "ready", "reconnect", "revoked"]),
  version: z.number().int().nonnegative(),
  tools: z.array(mcpTool).max(256),
  allowedTools: z.array(z.string()).max(256),
  projectGrants: z.array(z.uuid()),
  editable: z.boolean(),
});
export const mcpLibraryView = z.object({
  canManageSystem: z.boolean(),
  canManageProject: z.boolean(),
  entries: z.array(
    z.object({
      id: z.uuid(),
      scope: mcpScope,
      ownerId: z.uuid().nullable(),
      projectId: z.uuid().nullable(),
      editable: z.boolean(),
      cover: libraryCoverState.nullable().optional(),
      revisions: z.array(mcpRevision),
      connection: mcpConnectionView.nullable(),
    }),
  ),
  choices: z.array(mcpChoice),
  proposals: z.array(
    z.object({
      id: z.uuid(),
      revision: mcpRevision,
      target: z.enum(["project", "system"]),
      projectId: z.uuid().nullable(),
    }),
  ),
});
export const mcpConnectInput = z
  .object({
    commandId: z.uuid(),
    revisionId: z.uuid(),
    expectedVersion: z.number().int().nonnegative(),
    token: z
      .string()
      .trim()
      .min(1)
      .max(16000)
      .refine((value) => !/[\r\n]/.test(value))
      .optional(),
  })
  .strict();
export const mcpReviewInput = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    tools: z
      .array(z.object({ name: z.string(), digest: z.string() }).strict())
      .min(1)
      .max(256),
    confirmReadOnlyAccess: z.literal(true),
  })
  .strict();
export type MCPDefinition = z.infer<typeof mcpDefinition>;
export type MCPTool = z.infer<typeof mcpTool>;
export type MCPChoice = z.infer<typeof mcpChoice>;
export type MCPLibraryView = z.infer<typeof mcpLibraryView>;
export type MCPConnectionView = z.infer<typeof mcpConnectionView>;
export type MCPRole = z.infer<typeof mcpRole>;
export type MCPAssignment = {
  connectionId: string;
  credentialEpoch: string;
  revisionId: string;
  policyVersion: number;
  tools: MCPTool[];
  required: boolean;
};

export function resolveMCPChoice(
  choices: MCPChoice[],
  libraryId: string,
  role: MCPRole,
  personal = true,
) {
  let selected: MCPChoice | undefined;
  for (const scope of ["system", "project", ...(personal ? ["personal"] : [])]) {
    const choice = choices.find(
      (item) => item.libraryId === libraryId && item.scope === scope && item.role === role,
    );
    if (selected?.state !== "required" && choice && choice.state !== "inherit") selected = choice;
  }
  return selected;
}

export function validateMCPSelection(
  available: MCPTool[],
  selected: Array<{ name: string; digest: string }>,
) {
  if (
    !selected.length ||
    new Set(selected.map((tool) => tool.name)).size !== selected.length ||
    selected.some(
      (tool) =>
        !available.some(
          (candidate) => candidate.name === tool.name && candidate.digest === tool.digest,
        ),
    )
  )
    throw new Error("Review the current tools before approving read-only access");
  for (const tool of available.filter((tool) => selected.some((item) => item.name === tool.name))) {
    try {
      z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
    } catch {
      throw new Error(`The input schema for "${tool.name}" is not supported by the agent adapter`);
    }
  }
}

// Suggestions are definitions, never pre-authorized connections or enabled defaults.
export const recommendedMCPs: MCPDefinition[] = [
  {
    name: "Sentry",
    description:
      "Read error details and stacktraces. Use an endpoint scoped to your Sentry project.",
    endpoint: "https://mcp.sentry.dev/mcp",
    provider: "sentry",
    authentication: "oauth",
    roles: ["planning", "build"],
  },
  {
    name: "Datadog",
    description:
      "Investigate errors, logs and traces. Choose your Datadog region and a read-only account.",
    endpoint: "https://mcp.datadoghq.com/v1/mcp",
    provider: "datadog",
    authentication: "oauth",
    roles: ["planning", "build"],
  },
];
