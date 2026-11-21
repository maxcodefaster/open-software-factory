import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runProcess } from "../../scripts/owned-client-process";
import { analyzeArchitecture, architectureViolations } from "../../scripts/testing/architecture";

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
      'import type { TicketDetail } from "../projects/contracts";',
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
  for (const module of [
    "fs",
    "fs/promises",
    "child_process",
    "net",
    "tls",
    "path",
    "crypto",
    "http",
    "https",
    "os",
    "worker_threads",
  ])
    for (const prefix of ["", "node:"]) {
      const name = `${prefix}${module}`;
      const errors = architectureViolations(path, `import "${name}";`);
      expect(errors, name).toHaveLength(1);
      expect(errors[0]).toContain(`boundary rejects ${name}`);
    }
});

test("browser builtin matching preserves relative paths and neighboring names", () => {
  for (const name of [
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

async function architectureCLI(source: string, extra: Record<string, string> = {}) {
  const parent = resolve(import.meta.dir, "../../.factory/test-results");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "architecture-discovery-"));
  try {
    const script = resolve(root, "scripts/testing/architecture.ts");
    await mkdir(dirname(script), { recursive: true });
    await copyFile(resolve(import.meta.dir, "../../scripts/testing/architecture.ts"), script);
    await writeFile(
      resolve(root, "tsconfig.json"),
      '{"compilerOptions":{"moduleResolution":"Bundler"}}',
    );
    for (const file of cliModules) {
      const path = resolve(root, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source);
      await writeFile(path.replace(/(\.[^.]+)$/, ".test$1"), forbiddenSource);
    }
    for (const [file, content] of Object.entries(extra)) {
      await mkdir(dirname(resolve(root, file)), { recursive: true });
      await writeFile(resolve(root, file), content);
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

test("architecture CLI reads compiler aliases before checking imports", async () => {
  const result = await architectureCLI('import type { Client } from "@factory/database";', {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        moduleResolution: "Bundler",
        paths: { "@factory/database": ["./packages/db/src/client.ts"] },
      },
    }),
    "packages/db/src/client.ts": "export type Client = string;",
  });
  expect(result.code).toBe(1);
  for (const path of cliModules) expect(result.stderr).toContain(`${path}:1: Factory`);
  expect(result.stderr).toContain("rejects @factory/database [packages/db/src/client.ts]");
});

const fixtureRoot = "/factory-architecture-fixture";
function graph(sources: Record<string, string>, paths: Record<string, string[]> = {}) {
  return analyzeArchitecture(new Map(Object.entries(sources)), {
    root: fixtureRoot,
    compilerOptions: { baseUrl: fixtureRoot, paths },
  });
}

function featureErrors(result: ReturnType<typeof graph>) {
  return result.violations.filter((error) => error.includes("Factory feature boundary"));
}

test("browser boundaries cover feature server owners without banning public contracts", () => {
  for (const feature of [
    "access",
    "agent",
    "attachments",
    "bootstrap",
    "change",
    "delivery",
    "environments",
    "inbox",
    "knowledge",
    "learning",
    "mcp",
    "models",
    "monitoring",
    "project-agent",
    "projects",
    "releases",
    "repository-mirrors",
    "review",
    "runtime",
    "setup",
    "skills",
    "usage",
    "workspace",
  ]) {
    for (const owner of ["controller", "service", "store"])
      expect(
        architectureViolations(
          "apps/factory/src/ui/action.ts",
          `import type { Owner } from "../${feature}/${owner}";`,
        ).filter((error) => error.includes("Factory browser boundary")),
        `${feature}/${owner}`,
      ).toHaveLength(1);
    expect(
      architectureViolations(
        "apps/factory/src/ui/action.ts",
        `import type { View } from "../${feature}/contracts";`,
      ),
    ).toEqual([]);
  }
  for (const name of [
    "../storage/objects",
    "../installation/maintenance",
    "../server-functions/context",
    "../zero/server",
    "../delivery/integration",
    "../access/writer-controller",
    "@rocicorp/zero/server",
    "@modelcontextprotocol/server",
    "better-auth",
    "@better-auth/sso",
    "bun",
  ])
    expect(
      architectureViolations("apps/factory/src/ui/action.ts", `import "${name}";`).filter((error) =>
        error.includes("Factory browser boundary"),
      ),
      name,
    ).toHaveLength(1);
  for (const name of ["better-auth/client", "@better-auth/sso/client", "@rocicorp/zero"])
    expect(
      architectureViolations("apps/factory/src/ui/action.ts", `import "${name}";`),
      name,
    ).toEqual([]);
});

test("resolved aliases, barrels, type imports and JS specifiers expose the full browser chain", () => {
  const result = graph(
    {
      "apps/factory/src/screen.tsx": 'import { view } from "@factory/helper";',
      "apps/factory/src/review/helper.ts": 'export { view } from "./public/index.js";',
      "apps/factory/src/review/public/index.ts": 'export type { View as view } from "../hidden";',
      "apps/factory/src/review/hidden.ts": '\nimport type { Owner } from "@factory/delivery";',
      "apps/factory/src/delivery/controller.ts": "export type Owner = string;",
    },
    {
      "@factory/helper": ["apps/factory/src/review/helper.ts"],
      "@factory/delivery": ["apps/factory/src/delivery/controller.ts"],
    },
  );
  expect(
    result.violations.filter((error) => error.includes("Factory browser boundary")),
  ).toHaveLength(1);
  expect(featureErrors(result)).toHaveLength(1);
  expect(result.violations[0]).toContain(
    "review/hidden.ts:2: Factory browser boundary rejects @factory/delivery",
  );
  expect(result.violations[0]).toContain("[apps/factory/src/delivery/controller.ts]");
  expect(result.violations[0]).toContain(
    "screen.tsx:1 -> apps/factory/src/review/helper.ts:1 -> apps/factory/src/review/public/index.ts:1 -> apps/factory/src/review/hidden.ts:2",
  );
  expect(result.browserModules).toContain("apps/factory/src/review/helper.ts");
  expect(result.browserModules).not.toContain("apps/factory/src/delivery/controller.ts");
});

test("domain aliases resolve to owned domains and cannot disguise integration", () => {
  const result = graph(
    {
      "packages/project-domain/src/project.ts": 'export type { Runtime } from "@factory/runtime";',
      "packages/runtime-domain/src/index.ts": 'type Runtime = import("./hidden").Runtime;',
      "packages/runtime-domain/src/hidden.ts": 'import type { Client } from "@factory/database";',
      "packages/db/src/client.ts": "export type Client = string;",
    },
    {
      "@factory/runtime": ["packages/runtime-domain/src"],
      "@factory/database": ["packages/db/src/client.ts"],
    },
  );
  expect(result.violations).toHaveLength(1);
  expect(result.violations[0]).toContain(
    "runtime-domain/src/hidden.ts:1: Factory domain boundary rejects @factory/database",
  );
  expect(result.violations[0]).toContain("[packages/db/src/client.ts]");
  expect(
    graph({
      "packages/project-domain/src/project.ts": 'const adapter = await import("./adapter");',
      "packages/project-domain/src/adapter.ts": 'export * from "@mastra/core";',
    }).violations,
  ).toHaveLength(1);
});

test("aliases to installed packages preserve server-library identity and allow domain validation", () => {
  for (const [dependency, allowed] of [
    ["postgres", false],
    ["zod", true],
  ] as const) {
    const result = graph(
      {
        "apps/factory/src/screen.tsx": 'import "@factory/shared";',
        [`node_modules/${dependency}/index.d.ts`]: "export type Client = string;",
      },
      { "@factory/shared": [`node_modules/${dependency}/index.d.ts`] },
    );
    expect(result.violations.length === 0, dependency).toBe(allowed);
    if (!allowed) expect(result.violations[0]).toContain("postgres/index.d.ts");
  }
});

test("browser traversal stops at compiled server functions, not at arbitrary server-function barrels", () => {
  const sources = {
    "apps/factory/src/screen.tsx": 'import { deliver } from "./server-functions/delivery";',
    "apps/factory/src/server-functions/delivery.ts": `
import { createServerFn as rpc } from "@tanstack/solid-start";
import { controller } from "../delivery/controller";
export const deliver = rpc({ method: "POST" }).handler(() => controller());
`,
    "apps/factory/src/delivery/controller.ts":
      'import "postgres"; export const controller = () => true;',
  };
  expect(graph(sources).violations).toEqual([]);
  expect(graph(sources).browserModules).not.toContain("apps/factory/src/delivery/controller.ts");
  expect(
    graph({
      ...sources,
      "apps/factory/src/server-functions/delivery.ts":
        'export { controller as deliver } from "../delivery/controller";',
    }).violations.filter((error) => error.includes("Factory browser boundary")),
  ).toHaveLength(1);
  expect(
    graph({
      ...sources,
      "apps/factory/src/server-functions/delivery.ts": `${sources["apps/factory/src/server-functions/delivery.ts"]}
export type { Owner } from "../delivery/controller";`,
    }).violations.some((error) => error.includes("boundary rejects ../delivery/controller")),
  ).toBe(true);
});

test("public contracts and reachable helpers remain checked while unrelated server helpers stay server-owned", () => {
  const result = graph({
    "apps/factory/src/agent/contracts.ts": 'import type { Event } from "./events";',
    "apps/factory/src/agent/events.ts": 'export * from "@opencode/client";',
    "apps/factory/src/workspace/contracts.ts": "export type View = string;",
    "apps/factory/src/optional-values.ts": 'import { z } from "zod";',
    "apps/factory/src/agent/server-helper.ts": 'import "postgres";',
  });
  expect(
    result.violations.filter((error) => error.includes("Factory browser boundary")),
  ).toHaveLength(1);
  expect(featureErrors(result)).toHaveLength(1);
  expect(result.violations[0]).toContain("agent/events.ts:1");
  expect(result.browserModules).not.toContain("apps/factory/src/agent/server-helper.ts");
});

test("generated route registration does not make server routes browser helpers", () => {
  const result = graph({
    "apps/factory/src/router.tsx": 'import "./routeTree.gen";',
    "apps/factory/src/routeTree.gen.ts":
      'import "./routes/api/$"; import "./routes/index"; import type { Start } from "./start";',
    "apps/factory/src/routes/api/$.ts": 'import "postgres";',
    "apps/factory/src/routes/index.tsx": "export const view = true;",
    "apps/factory/src/start.ts": 'import type { Context } from "./server-functions/context";',
    "apps/factory/src/server-functions/context.ts": "export type Context = string;",
  });
  expect(result.violations).toEqual([]);
  expect(result.browserModules).not.toContain("apps/factory/src/routes/api/$.ts");
  expect(
    graph({
      "apps/factory/src/router.tsx": 'import "./routes/api/$";',
      "apps/factory/src/routes/api/$.ts": 'import "postgres";',
    }).violations,
  ).toHaveLength(1);
});

test("cycle diagnostics include feature, domain, re-export, dynamic and type-only edges", () => {
  for (const source of [
    'import "./b";',
    'export * from "./b";',
    'export type { B } from "./b";',
    'type B = import("./b").B;',
    'await import("./b");',
  ])
    for (const owner of ["apps/factory/src/delivery", "packages/project-domain/src"]) {
      const result = graph({
        [`${owner}/a.ts`]: `\n${source}`,
        [`${owner}/b.ts`]: 'import "./a"; export type B = string;',
      });
      expect(result.violations, source).toHaveLength(1);
      expect(result.violations[0]).toContain(
        `Factory dependency cycle: ${owner}/a.ts:2 -> ${owner}/b.ts:1 -> ${owner}/a.ts`,
      );
    }
  expect(
    graph({
      "apps/factory/src/delivery/a.ts": 'import "./a";',
    }).violations,
  ).toHaveLength(1);
  expect(
    graph({
      "apps/factory/src/delivery/a.ts": 'import "./c";',
      "apps/factory/src/delivery/b.ts": 'import "./c";',
      "apps/factory/src/delivery/c.ts": "export const shared = true;",
    }).violations,
  ).toEqual([]);
});

test("only exact generated owners and internal relational schema edges are exempt from cycles", () => {
  expect(
    graph({
      "packages/db/src/schema/projects.ts": 'import "./tickets";',
      "packages/db/src/schema/tickets.ts": 'import "./projects";',
      "apps/factory/src/router.tsx": 'import "./routeTree.gen";',
      "apps/factory/src/routeTree.gen.ts": 'import type { Router } from "./router";',
    }).violations,
  ).toEqual([]);
  for (const owner of [
    "packages/db/src",
    "apps/factory/src/agent/schema",
    "apps/factory/src/generated",
  ])
    expect(
      graph({
        [`${owner}/a.ts`]: 'import "./b";',
        [`${owner}/b.ts`]: 'import "./a";',
      }).violations,
    ).toHaveLength(1);
  expect(
    graph({
      "packages/db/src/schema/projects.ts": 'import "../query";',
      "packages/db/src/query.ts": 'import "./schema/projects";',
    }).violations,
  ).toHaveLength(1);
});

test("the ESM product rule rejects CommonJS without banning the existing Theia type adapter or upstream runner text", async () => {
  const repository = resolve(import.meta.dir, "../..");
  const biome = resolve(repository, "node_modules/.bin/biome");
  const parent = resolve(repository, ".factory/test-results");
  await mkdir(parent, { recursive: true });
  const fixture = await mkdtemp(resolve(parent, "architecture-esm-"));
  try {
    await copyFile(resolve(repository, "biome.json"), resolve(fixture, "biome.json"));
    async function lint(file: string, source: string) {
      await mkdir(dirname(resolve(fixture, file)), { recursive: true });
      await writeFile(resolve(fixture, file), source);
      return runProcess([biome, "lint", file], { cwd: fixture, allowFailure: true });
    }
    for (const source of ['const client = require("zod");\n', "module.exports = {};\n"] as const) {
      const result = await lint("apps/factory/src/ui/boundary.ts", source);
      expect(result.code, source).toBe(1);
      expect(result.stderr).toContain("lint/style/noCommonJs");
    }
    for (const [file, source] of [
      [
        "apps/factory/src/ui/boundary.ts",
        'import { z } from "zod";\nexport const value = z.string();\n',
      ],
      [
        "packages/runtime-kubernetes/src/verification-process.ts",
        'export const supervisor = `const spawn = require("node:child_process");`;\n',
      ],
      [
        "deploy/theia-ide/factory-ide-extension/src/browser/factory-workspace-widget.ts",
        'import type React = require("@theia/core/shared/react");\nexport type Element = React.ReactNode;\n',
      ],
    ] as const) {
      const result = await lint(file, source);
      expect(result.code, `${file}\n${result.stderr}`).toBe(0);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("the product ESM check also rejects TypeScript import and export assignments", () => {
  for (const source of [
    'import client = require("zod");',
    'import type Client = require("zod");',
    "export = {};",
  ]) {
    expect(architectureViolations("packages/runtime-kubernetes/src/adapter.ts", source)).toEqual([
      "packages/runtime-kubernetes/src/adapter.ts:1: Factory ESM product code rejects TypeScript CommonJS assignments. Use ESM imports/exports.",
    ]);
    expect(
      architectureViolations(
        "deploy/theia-ide/factory-ide-extension/src/browser/adapter.ts",
        source,
      ),
    ).toEqual([]);
  }
});

test("feature boundaries reject private value, type, re-export and dynamic imports through aliases", () => {
  for (const source of [
    'import { Engine } from "@factory/engine";',
    'import type { Engine } from "@factory/engine";',
    'import { type Engine } from "@factory/engine";',
    'type Engine = import("@factory/engine").Engine;',
    'export { Engine } from "@factory/engine";',
    'await import("@factory/engine");',
  ]) {
    const errors = featureErrors(
      graph(
        {
          "apps/factory/src/learning/worker.ts": `\n${source}`,
          "apps/factory/src/monitoring/private-engine.ts": "export type Engine = string;",
        },
        { "@factory/engine": ["apps/factory/src/monitoring/private-engine.ts"] },
      ),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      "learning/worker.ts:2: Factory feature boundary rejects @factory/engine",
    );
    expect(errors[0]).toContain("[apps/factory/src/monitoring/private-engine.ts]");
    expect(errors[0]).toContain("public API, authority or contract");
  }
  expect(
    featureErrors(
      graph({
        "apps/factory/src/learning/worker.ts": "await import(moduleName);",
      }),
    )[0],
  ).toContain("requires a literal module path");
});

test("canonical feature APIs, clients and named facets select their own exports while implementation stays private", () => {
  for (const [api, client] of [
    ["api", "client"],
    ["admission-api", "navigation-client"],
  ]) {
    const result = graph({
      "apps/factory/src/learning/worker.ts": `import { admit } from "../monitoring/${api}";`,
      [`apps/factory/src/monitoring/${api}.ts`]: 'export { admit } from "./controller";',
      "apps/factory/src/monitoring/controller.ts":
        'import "./store"; export const admit = () => true;',
      "apps/factory/src/monitoring/store.ts": "export const storage = true;",
      "apps/factory/src/knowledge/view.tsx": `import { next } from "../monitoring/${client}";`,
      [`apps/factory/src/monitoring/${client}.ts`]: 'export { next } from "./client-state";',
      "apps/factory/src/monitoring/client-state.ts": "export const next = () => true;",
    });
    expect(result.violations).toEqual([]);
    expect(result.browserModules).toContain(`apps/factory/src/monitoring/${client}.ts`);
  }
  expect(
    featureErrors(
      graph({
        "apps/factory/src/learning/worker.ts": 'import "../monitoring/controller";',
        "apps/factory/src/monitoring/controller.ts": "export const admit = () => true;",
      }),
    ),
  ).toHaveLength(1);
  for (const entry of ["api", "client", "admission-api", "navigation-client"]) {
    for (const source of [
      'export * from "./controller";',
      'export * as internals from "./controller";',
      'import * as internals from "./controller"; export { internals };',
      'export * from "zod";',
    ])
      expect(
        featureErrors(
          graph({
            [`apps/factory/src/monitoring/${entry}.ts`]: source,
            "apps/factory/src/monitoring/controller.ts": "export const admit = () => true;",
          }),
        )[0],
      ).toContain("must select named exports");
    expect(
      featureErrors(
        graph({
          [`apps/factory/src/monitoring/${entry}.ts`]:
            'export { admit } from "../learning/controller";',
          "apps/factory/src/learning/controller.ts": "export const admit = () => true;",
        }),
      ),
    ).toHaveLength(1);
  }
  expect(
    graph({
      "apps/factory/src/monitoring/navigation-client.ts": 'export { next } from "./client-state";',
      "apps/factory/src/monitoring/client-state.ts": 'import "postgres";',
    }).violations.filter((error) => error.includes("Factory browser boundary")),
  ).toEqual([
    "apps/factory/src/monitoring/client-state.ts:1: Factory browser boundary rejects postgres. Use a domain contract or authenticated server function. Import chain: apps/factory/src/monitoring/navigation-client.ts:1 -> apps/factory/src/monitoring/client-state.ts:1.",
  ]);
  expect(
    graph({
      "apps/factory/src/monitoring/admission-api.ts": 'export type { Input } from "./controller";',
      "apps/factory/src/monitoring/controller.ts":
        'import type { Input } from "./admission-api"; export type Input = string;',
    }).violations,
  ).toEqual([
    "apps/factory/src/monitoring/controller.ts:1: Factory dependency cycle: apps/factory/src/monitoring/admission-api.ts:1 -> apps/factory/src/monitoring/controller.ts:1 -> apps/factory/src/monitoring/admission-api.ts. Move shared contracts or helpers to their owner; type imports count too.",
  ]);
  expect(
    featureErrors(
      graph({
        "apps/factory/src/monitoring/service.ts": 'export { admit } from "./controller";',
        "apps/factory/src/monitoring/controller.ts": "export const admit = () => true;",
      }),
    ),
  ).toHaveLength(1);
  expect(
    featureErrors(
      graph({
        "apps/factory/src/monitoring/service.ts":
          'import { admit } from "./controller"; export { admit };',
        "apps/factory/src/monitoring/controller.ts": "export const admit = () => true;",
      }),
    ),
  ).toHaveLength(1);
  const serverAdapter = {
    "apps/factory/src/agent/opencode-adapter.ts":
      'import { OpenCode } from "@opencode/client"; export function createOpenCodeClient() { return new OpenCode(); }',
  };
  const serverFacade = graph({
    ...serverAdapter,
    "apps/factory/src/agent/opencode-api.ts":
      'import { createOpenCodeClient } from "./opencode-adapter"; export { createOpenCodeClient };',
    "apps/factory/src/learning/worker.ts":
      'import { createOpenCodeClient } from "../agent/opencode-api";',
  });
  expect(serverFacade.violations).toEqual([]);
  expect(serverFacade.browserModules).not.toContain("apps/factory/src/agent/opencode-adapter.ts");
  expect(
    featureErrors(
      graph({
        ...serverAdapter,
        "apps/factory/src/learning/worker.ts": 'import "../agent/opencode-adapter";',
      }),
    ),
  ).toHaveLength(1);
  expect(
    graph({
      ...serverAdapter,
      "apps/factory/src/desktop/helper.ts": 'import "../agent/opencode-adapter";',
    }).violations.some((error) => error.includes("Factory browser boundary")),
  ).toBe(true);
});

test("feature contracts cannot derive or re-export private implementations", () => {
  for (const owner of ["controller", "api", "service", "client", "admission-api", "view-client"])
    for (const source of [
      `import type { Controller } from "./${owner}";`,
      `export type { Controller } from "./${owner}";`,
      `type Controller = import("./${owner}").Controller;`,
    ])
      expect(
        featureErrors(
          graph({
            "apps/factory/src/monitoring/execution-contracts.ts": source,
            [`apps/factory/src/monitoring/${owner}.ts`]: "export type Controller = string;",
          }),
        )[0],
      ).toContain("contracts must be independent");
  expect(
    graph({
      "apps/factory/src/learning/worker.ts":
        'import type { Input } from "../monitoring/contracts";',
      "apps/factory/src/monitoring/contracts.ts":
        'import type { Ticket } from "../../../../packages/ticket-domain/src/ticket"; export type Input = Ticket;',
      "packages/ticket-domain/src/ticket.ts": "export type Ticket = string;",
    }).violations,
  ).toEqual([]);
  expect(
    featureErrors(
      graph({
        "apps/factory/src/access/commands.ts": 'import type { Controller } from "./controller";',
        "apps/factory/src/access/controller.ts": "export type Controller = string;",
      }),
    )[0],
  ).toContain("contracts must be independent");
  expect(
    graph({
      "apps/factory/src/workspace/commands.ts":
        'import { authorize } from "../access/authority"; import { compute } from "./compute-access"; export const execute = () => authorize() && compute();',
      "apps/factory/src/access/authority.ts": "export const authorize = () => true;",
      "apps/factory/src/workspace/compute-access.ts": "export const compute = () => true;",
    }).violations,
  ).toEqual([]);
  expect(
    featureErrors(
      graph({
        "apps/factory/src/monitoring/worker.ts": 'import "../workspace/commands";',
        "apps/factory/src/workspace/commands.ts": "export const execute = () => true;",
      }),
    ),
  ).toHaveLength(1);
});

test("composition owners may assemble features, but frontend helpers and fake RPCs are not composition", () => {
  for (const file of [
    "apps/factory/src/application.ts",
    "apps/factory/src/server/application.ts",
    "apps/factory/src/bootstrap/service.ts",
    "apps/factory/src/desktop/commands.ts",
  ]) {
    const result = graph({
      [file]: `import "${file.endsWith("/src/application.ts") ? "./" : "../"}monitoring/controller";`,
      "apps/factory/src/monitoring/controller.ts": "export const controller = true;",
    });
    expect(featureErrors(result), file).toEqual([]);
    if (file.includes("/desktop/"))
      expect(result.violations.some((error) => error.includes("Factory browser boundary"))).toBe(
        true,
      );
  }
  for (const file of [
    "apps/factory/src/ui/helper.ts",
    "apps/factory/src/learning/view.tsx",
    "apps/factory/src/server-functions/fake.ts",
  ])
    expect(
      featureErrors(
        graph({
          [file]: 'import "../monitoring/private-helper";',
          "apps/factory/src/monitoring/private-helper.ts": "export const helper = true;",
        }),
      ),
      file,
    ).toHaveLength(1);
  expect(
    graph({
      "apps/factory/src/server-functions/admit.ts":
        'import { createServerFn } from "@tanstack/solid-start"; import { admit } from "../monitoring/controller"; export const call = createServerFn({ method: "POST" }).handler(() => admit());',
      "apps/factory/src/monitoring/controller.ts": "export const admit = () => true;",
    }).violations,
  ).toEqual([]);
  expect(
    graph({
      "apps/factory/src/ui/helper.ts": 'import { put } from "../storage/objects";',
      "apps/factory/src/storage/objects.ts":
        'import { S3Client } from "bun"; export const put = () => true;',
    }).violations.some((error) => error.includes("Factory browser boundary")),
  ).toBe(true);
});

test("root and package re-export helpers cannot reset a feature's owner", () => {
  const result = graph({
    "apps/factory/src/learning/worker.ts": 'export type { Engine } from "../shared";',
    "apps/factory/src/shared.ts":
      'export type { Engine } from "../../../packages/shared/src/index";',
    "packages/shared/src/index.ts":
      'export type { Engine } from "../../../apps/factory/src/monitoring/private-engine";',
    "apps/factory/src/monitoring/private-engine.ts": "export type Engine = string;",
  });
  expect(featureErrors(result)).toHaveLength(1);
  expect(featureErrors(result)[0]).toContain("packages/shared/src/index.ts:1");
  expect(featureErrors(result)[0]).toContain(
    "Import chain: apps/factory/src/learning/worker.ts:1 -> apps/factory/src/shared.ts:1 -> packages/shared/src/index.ts:1",
  );
});

test("domain modules reject arbitrary pure helpers outside owned domain source", () => {
  for (const source of [
    'import { pure } from "../../../scripts/pure";',
    'import type { Pure } from "../../../scripts/pure";',
    'export { pure } from "@factory/pure";',
    'await import("../../../scripts/pure");',
  ]) {
    const result = graph(
      {
        "packages/project-domain/src/project.ts": source,
        "scripts/pure.ts": "export const pure = true; export type Pure = string;",
      },
      { "@factory/pure": ["scripts/pure.ts"] },
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("Factory domain boundary rejects");
    expect(result.violations[0]).toContain("[scripts/pure.ts]");
  }
  expect(
    graph({
      "packages/project-domain/src/project.ts":
        'import { pure } from "../../ticket-domain/src/pure"; import { z } from "zod"; import "diff"; import "node:crypto"; import "node:path";',
      "packages/ticket-domain/src/pure.ts": "export const pure = true;",
    }).violations,
  ).toEqual([]);
});
