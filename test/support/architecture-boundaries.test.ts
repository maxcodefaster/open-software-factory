import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runProcess } from "../../scripts/owned-client-process";
import { architectureViolations } from "../../scripts/testing/architecture";

test("architecture lints keep domain and browser code behind Factory adapters", () => {
  for (const [path, source, allowed] of [
    [
      "packages/project-domain/src/boundary.ts",
      'import type { Session } from "@opencode/client";',
      false,
    ],
    [
      "packages/project-domain/src/boundary.ts",
      'export { Agent } from "@mastra/core/agent";',
      false,
    ],
    [
      "packages/project-domain/src/boundary.ts",
      'import type { OAuthContext } from "@modelcontextprotocol/server";',
      false,
    ],
    ["packages/project-domain/src/boundary.ts", 'export * from "../../db/src/client";', false],
    [
      "packages/project-domain/src/boundary.ts",
      'const client = await import("../../db/src/client");',
      false,
    ],
    [
      "packages/project-domain/src/boundary.ts",
      'type Client = import("../../db/src/client").Client;',
      false,
    ],
    [
      "packages/project-domain/src/boundary.ts",
      'const client = require("../../db/src/client");',
      false,
    ],
    [
      "packages/project-domain/src/boundary.ts",
      'import { Agent } from "../../../node_modules/@mastra/core";',
      false,
    ],
    [
      "packages/project-domain/src/boundary.ts",
      'import { adapter } from "../../../../outside/adapter";',
      false,
    ],
    ["apps/factory/src/desktop/boundary.ts", 'import postgres from "postgres";', false],
    [
      "packages/project-domain/src/boundary.ts",
      'import client = require("../../db/src/client");',
      false,
    ],
    [
      "packages/project-domain/src/boundary.ts",
      'import { client } from "../../project-domain/../db/src/client";',
      false,
    ],
    ["packages/project-domain/src/boundary.ts", "const client = await import(moduleName);", false],
    [
      "packages/project-domain/src/boundary.ts",
      'import { createDatabase } from "../../db/src/client";',
      false,
    ],
    [
      "packages/project-domain/src/boundary.ts",
      'import { controller } from "../../../apps/factory/src/runtime/controller";',
      false,
    ],
    ["packages/project-domain/src/boundary.ts", 'import { z } from "zod";', true],
    ["packages/project-domain/src/boundary.ts", 'import { createHash } from "node:crypto";', true],
    [
      "packages/project-domain/src/boundary.ts",
      'import type { Ticket } from "../../ticket-domain/src/ticket";',
      true,
    ],
    [
      "apps/factory/src/desktop/boundary.ts",
      'import { createDatabase } from "../../../../packages/db/src/client";',
      false,
    ],
    [
      "apps/factory/src/ui/boundary.tsx",
      'import { createOpenBaoKV } from "../secrets/openbao";',
      false,
    ],
    [
      "apps/factory/src/navigation/boundary.ts",
      'import { nativeModel } from "../models/native";',
      false,
    ],
    ["apps/factory/src/desktop/boundary.ts", 'import { readFile } from "node:fs/promises";', false],
    [
      "apps/factory/src/desktop/boundary.ts",
      'import { saveTicketDocument } from "../server-functions/tickets";',
      true,
    ],
    ["apps/factory/src/ui/boundary.tsx", 'import { createSignal } from "solid-js";', true],
    [
      "apps/factory/src/desktop/boundary.ts",
      'import type { TicketDetail } from "../api-contracts";',
      true,
    ],
    [
      "packages/project-domain/src/boundary.test.ts",
      'import { createDatabase } from "../../db/src/client";',
      true,
    ],
  ] as const) {
    const errors = architectureViolations(path, source);
    expect(errors.length === 0, `${path}: ${source}\n${errors.join("\n")}`).toBe(allowed);
    if (!allowed) expect(errors.join("\n")).toContain("Factory");
  }
});

test("browser boundaries reject Node server builtins with either spelling", () => {
  const path = "apps/factory/src/desktop/boundary.ts";
  for (const module of ["fs", "fs/promises", "child_process", "net", "tls"])
    for (const prefix of ["", "node:"]) {
      const name = `${prefix}${module}`;
      const errors = architectureViolations(path, `import "${name}";`);
      expect(errors, name).toHaveLength(1);
      expect(errors[0]).toContain(`boundary rejects ${name}`);
    }
});

test("browser builtin matching preserves relative paths and neighboring names", () => {
  for (const name of [
    "node:path",
    "path",
    "fs-extra",
    "child_process_tools",
    "netlify",
    "tls-client",
    "./fs",
    "./child_process",
  ])
    expect(
      architectureViolations("apps/factory/src/desktop/boundary.ts", `import "${name}";`),
      name,
    ).toEqual([]);
});

const cliModules = ["ts", "tsx", "mts", "cts"].flatMap((extension) => [
  `packages/project-domain/src/boundary.${extension}`,
  `apps/factory/src/ui/boundary.${extension}`,
]);
const forbiddenSource = 'import type { Session } from "@opencode/client";';

async function architectureCLI(source: string) {
  const parent = resolve(import.meta.dir, "../../.factory/test-results");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "architecture-discovery-"));
  try {
    const script = resolve(root, "scripts/testing/architecture.ts");
    await mkdir(dirname(script), { recursive: true });
    await copyFile(resolve(import.meta.dir, "../../scripts/testing/architecture.ts"), script);
    for (const file of cliModules) {
      const path = resolve(root, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source);
      await writeFile(path.replace(/(\.[^.]+)$/, ".test$1"), forbiddenSource);
    }
    return await runProcess([process.execPath, "--no-env-file", script], {
      cwd: root,
      allowFailure: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("architecture CLI discovers ts, tsx, mts and cts in domain and browser owners", async () => {
  const result = await architectureCLI(forbiddenSource);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain(
    `Factory architecture: ${cliModules.length} owned modules, ${cliModules.length} violations`,
  );
  for (const path of cliModules) expect(result.stderr).toContain(`${path}:1: Factory`);
});

test("architecture CLI accepts supported extensions and excludes their test modules", async () => {
  const result = await architectureCLI("export const boundary = true;");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    `Factory architecture: ${cliModules.length} owned modules, 0 violations`,
  );
  expect(result.stderr).toBe("");
});
