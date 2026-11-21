import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  findForbidden,
  forbiddenTermPattern,
  gateSteps,
  parseForbiddenTerms,
  runGate,
} from "./beta-gate";

test("terms come from a plain list and ignore comments", () => {
  expect(parseForbiddenTerms("# why\nacme-secret\n\n  other \n")).toEqual(["acme-secret", "other"]);
});

test("a term is a whole word, so longer words that contain it do not match", () => {
  const terms = ["acme"];
  expect(findForbidden(terms, "readAccount and 51ec7abc08af40adac669837530e8c23")).toEqual([]);
  expect(findForbidden(terms, "Owned ACME Preview, acme-astro and /owned/acme.git")).toEqual([
    "acme",
    "acme",
    "acme",
  ]);
  expect(forbiddenTermPattern(["a.c"]).test("abc")).toBe(false);
});

test("the source gate includes both Connector and native control bridge checks before owned UI", () => {
  const names = gateSteps().map((step) => step.name);
  expect(names).toEqual([
    "docs",
    "db-schema",
    "zero-schema",
    "format",
    "lint",
    "typecheck",
    "unit",
    "connector",
    "substrate",
    "controllers",
    "browser",
  ]);
  expect(gateSteps().find((step) => step.name === "substrate")?.command).toEqual([
    "bun",
    "run",
    "substrate:check",
  ]);
});

const revision = "a".repeat(40);
async function gateFixture(
  input: {
    scannerExit?: number;
    report?: string;
    staleReport?: string;
    changed?: "head" | "tree" | "git-error";
    override?: "FACTORY_BROWSER_BASE_URL" | "FACTORY_BUILD_DIRECTORY";
  } = {},
) {
  const parent = resolve(".factory/test-results");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "gate-contract-"));
  const bin = resolve(root, "bin");
  const evidence = resolve(root, ".factory/test-results/beta-gate");
  await mkdir(bin);
  await mkdir(evidence, { recursive: true });
  await mkdir(resolve(root, "scripts/release"), { recursive: true });
  await writeFile(resolve(root, ".factory/forbidden-terms.txt"), "owned-never-published-term");
  await writeFile(resolve(root, "scripts/release/gitleaks-reviewed.json"), '["fixture:owned.ts"]');
  if (input.staleReport !== undefined)
    await writeFile(resolve(evidence, "gitleaks.json"), input.staleReport);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const scripts = {
    git: `#!/bin/sh
case "$1" in
  rev-parse)
    if test -f ${quote(resolve(root, "ran-check"))}; then
      ${input.changed === "git-error" ? "exit 128" : ""}
      printf '%s\\n' '${input.changed === "head" ? "b".repeat(40) : revision}'
    else printf '%s\\n' '${revision}'; fi ;;
  status)
    if test -f ${quote(resolve(root, "ran-check"))}; then
      ${input.changed === "git-error" ? "exit 128" : ""}
      ${input.changed === "tree" ? "printf ' M source.ts\\n'" : ":"}
    fi ;;
  ls-files|log|tag) : ;;
  *) exit 128 ;;
esac
`,
    docker: `#!/bin/sh
for arg do
  case "$arg" in *:/out) output="\${arg%:/out}/gitleaks.json" ;; esac
done
${input.report !== undefined ? `printf '%s' ${quote(input.report)} > "$output"` : ":"}
exit ${input.scannerExit ?? 0}
`,
    bun: `#!/bin/sh
: > ${quote(resolve(root, "ran-check"))}
exit 0
`,
  };
  for (const [name, source] of Object.entries(scripts)) {
    await writeFile(resolve(bin, name), source);
    await chmod(resolve(bin, name), 0o700);
  }
  try {
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${bin}:${process.env["PATH"]}`,
      FACTORY_FORBIDDEN_TERMS_FILE: resolve(root, ".factory/forbidden-terms.txt"),
    };
    delete env["FACTORY_BROWSER_BASE_URL"];
    delete env["FACTORY_BUILD_DIRECTORY"];
    if (input.override) env[input.override] = "/unbound-caller-artifact";
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `const {runGate}=await import(${JSON.stringify(resolve(import.meta.dir, "beta-gate.ts"))});
console.log("FIXTURE_RESULT:"+JSON.stringify(await runGate(${JSON.stringify(root)})));`,
      ],
      { cwd: root, env, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const result = stdout.split("\n").find((line) => line.startsWith("FIXTURE_RESULT:"));
    if (!result || status !== 0) throw new Error(`Gate fixture failed: ${stderr}`);
    return JSON.parse(result.slice("FIXTURE_RESULT:".length)) as Awaited<
      ReturnType<typeof runGate>
    >;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("scanner execution and fresh report are required, even when old findings were reviewed", async () => {
  for (const input of [
    { scannerExit: 125 },
    { scannerExit: 1, report: "[]" },
    { scannerExit: 0 },
    { scannerExit: 0, staleReport: "[]" },
    { scannerExit: 0, report: "{}" },
    { scannerExit: 0, report: "not JSON" },
    { scannerExit: 0, report: '[{"RuleID":"fixture","File":"owned.ts"}]' },
  ]) {
    const result = await gateFixture(input);
    expect(result.passed, JSON.stringify(input)).toBe(false);
    expect(result.steps.find((step) => step.name === "secrets")?.passed).toBe(false);
  }
  expect((await gateFixture({ report: "[]" })).passed).toBe(true);
  expect(
    (
      await gateFixture({
        scannerExit: 3,
        report: '[{"RuleID":"fixture","File":"owned.ts"}]',
      })
    ).passed,
  ).toBe(true);
  expect(
    (
      await gateFixture({
        scannerExit: 3,
        report: '[{"RuleID":"unreviewed","File":"owned.ts"}]',
      })
    ).passed,
  ).toBe(false);
});

test("a receipt cannot pass if source changes during checks or Git observation fails", async () => {
  for (const changed of ["head", "tree", "git-error"] as const)
    expect((await gateFixture({ report: "[]", changed })).passed, changed).toBe(false);
});

test("the exact-source gate refuses caller-provided browser hosts and build directories", async () => {
  for (const override of ["FACTORY_BROWSER_BASE_URL", "FACTORY_BUILD_DIRECTORY"] as const)
    expect((await gateFixture({ report: "[]", override })).passed, override).toBe(false);
});

test("a cancelled gate admits no scanner or verification subprocess", async () => {
  const stopped = AbortSignal.abort("owned-gate-stop");
  await expect(runGate(".", stopped)).rejects.toBe("owned-gate-stop");
});

test("the release workflow accepts the producer receipt and rejects incomplete or mismatched receipts", async () => {
  const workflow = await readFile(".github/workflows/images.yaml", "utf8");
  const expression = workflow.match(
    /jq -e --arg revision "\$revision" '([\s\S]*?)' "\$RUNNER_TEMP\/local-gate.json"/,
  )?.[1];
  if (!expression) throw new Error("Release receipt validator not found");
  const receipt = {
    schema: 1,
    scope: "source-controller-ui",
    nativeProductAcceptance: false,
    commit: revision,
    passed: true,
    steps: [
      "clean-tree",
      "forbidden-terms",
      "secrets",
      ...gateSteps().map((step) => step.name),
    ].map((name) => ({ name, passed: true, seconds: 0 })),
  };
  async function accepted(value: unknown) {
    const child = Bun.spawn(["jq", "-e", "--arg", "revision", revision, expression ?? ""], {
      stdin: new Blob([JSON.stringify(value)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return (await child.exited) === 0;
  }
  expect(await accepted(receipt)).toBe(true);
  expect(await accepted({ ...receipt, commit: "b".repeat(40) })).toBe(false);
  expect(await accepted({ ...receipt, passed: false })).toBe(false);
  expect(await accepted({ ...receipt, nativeProductAcceptance: true })).toBe(false);
  for (let index = 0; index < receipt.steps.length; index++) {
    expect(await accepted({ ...receipt, steps: receipt.steps.toSpliced(index, 1) })).toBe(false);
    expect(
      await accepted({
        ...receipt,
        steps: receipt.steps.map((step, position) =>
          position === index ? { ...step, passed: false } : step,
        ),
      }),
    ).toBe(false);
  }
});
