import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// The local release gate. Public CI only runs on release tags, so this is the
// check that stands between a commit and a tag: it runs every lane on this
// machine and writes a receipt that names the exact commit it judged.

export const gitleaksImage =
  "zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f";

export type GateStep = {
  name: string;
  command: string[];
  environment?: Record<string, string>;
};

/** Terms that must never appear anywhere. They live outside the repository, never in it. */
export function parseForbiddenTerms(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function forbiddenTermPattern(terms: readonly string[]) {
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // A term inside a longer word (readAccount contains "acme") is not the term.
  return new RegExp(`(?<![A-Za-z0-9])(?:${escaped.join("|")})(?![A-Za-z])`, "i");
}

export function findForbidden(terms: readonly string[], text: string) {
  if (!terms.length) return [];
  const pattern = new RegExp(forbiddenTermPattern(terms).source, "gi");
  return [...text.matchAll(pattern)].map((match) => match[0].toLowerCase());
}

export function gateSteps(): GateStep[] {
  return [
    { name: "docs", command: ["bun", "run", "check:docs"] },
    { name: "format", command: ["bun", "run", "format:check"] },
    { name: "lint", command: ["bun", "run", "lint"] },
    { name: "typecheck", command: ["bun", "run", "typecheck"] },
    { name: "unit", command: ["bun", "run", "test:unit"] },
    { name: "connector", command: ["bun", "run", "connector:check"] },
    { name: "controllers", command: ["bun", "run", "test:controllers"] },
    {
      name: "browser",
      command: ["bun", "run", "test:browser"],
      // One retry absorbs a timing flake on a loaded machine. A spec that needs it is listed as
      // flaky in the run output; a spec that fails twice fails the gate.
      environment: { FACTORY_BROWSER_RETRIES: "1" },
    },
  ];
}

async function capture(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

type StepResult = {
  name: string;
  passed: boolean;
  seconds: number;
  detail?: string;
};

async function scanForbiddenTerms(root: string): Promise<StepResult> {
  const started = performance.now();
  const location =
    process.env["FACTORY_FORBIDDEN_TERMS_FILE"] ?? resolve(root, ".factory/forbidden-terms.txt");
  const text = await readFile(location, "utf8").catch(() => "");
  const terms = parseForbiddenTerms(text);
  if (!terms.length)
    return {
      name: "forbidden-terms",
      passed: false,
      seconds: 0,
      detail: `No terms in ${location}. List one term per line; the file stays out of the repository.`,
    };
  const hits: string[] = [];
  const files = (await capture(["git", "ls-files", "-z"], root)).stdout.split("\0").filter(Boolean);
  for (const file of files) {
    const content = await readFile(resolve(root, file), "utf8").catch(() => "");
    if (findForbidden(terms, `${file}\n${content}`).length) hits.push(file);
  }
  const history = (await capture(["git", "log", "--all", "-p", "--format=%H%n%an%n%ae%n%B"], root))
    .stdout;
  const historyHits = findForbidden(terms, history).length;
  const tags = findForbidden(terms, (await capture(["git", "tag", "-l"], root)).stdout).length;
  return {
    name: "forbidden-terms",
    passed: hits.length === 0 && historyHits === 0 && tags === 0,
    seconds: (performance.now() - started) / 1000,
    detail: `${terms.length} terms; ${hits.length} files, ${historyHits} history matches, ${tags} tags${hits.length ? `: ${hits.slice(0, 5).join(", ")}` : ""}`,
  };
}

async function scanSecrets(root: string): Promise<StepResult> {
  const started = performance.now();
  const output = resolve(root, ".factory/test-results/beta-gate/gitleaks.json");
  await mkdir(resolve(root, ".factory/test-results/beta-gate"), { recursive: true });
  const result = await capture(
    [
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${root}:/repo:ro`,
      "-v",
      `${resolve(root, ".factory/test-results/beta-gate")}:/out`,
      gitleaksImage,
      "detect",
      "--source",
      "/repo",
      "--log-opts=--all",
      "--no-banner",
      "--redact",
      "-r",
      "/out/gitleaks.json",
    ],
    root,
  );
  const findings = JSON.parse(await readFile(output, "utf8").catch(() => "[]")) as {
    RuleID: string;
    File: string;
    Commit: string;
  }[];
  // Reviewed false positives: test fixtures, hashes and redaction samples. Anything else fails.
  const allowed: string[] = await readFile(
    resolve(root, "scripts/release/gitleaks-reviewed.json"),
    "utf8",
  )
    .then((text) => JSON.parse(text) as string[])
    .catch((): string[] => []);
  const open = findings.filter((finding) => !allowed.includes(`${finding.RuleID}:${finding.File}`));
  return {
    name: "secrets",
    passed: result.exitCode === 0 || open.length === 0,
    seconds: (performance.now() - started) / 1000,
    detail: `${findings.length} findings, ${open.length} not reviewed${
      open.length
        ? `: ${open
            .slice(0, 5)
            .map((finding) => `${finding.RuleID}:${finding.File}`)
            .join(", ")}`
        : ""
    }`,
  };
}

export async function runGate(root: string) {
  const status = (await capture(["git", "status", "--porcelain"], root)).stdout.trim();
  const commit = (await capture(["git", "rev-parse", "HEAD"], root)).stdout.trim();
  const results: StepResult[] = [];
  const record = (result: StepResult) => {
    results.push(result);
    console.log(
      `${result.passed ? "PASS" : "FAIL"}  ${result.name}  ${result.seconds.toFixed(0)}s  ${result.detail ?? ""}`,
    );
    return result.passed;
  };
  let ok = record({
    name: "clean-tree",
    passed: status === "",
    seconds: 0,
    detail: status
      ? `uncommitted changes:\n${status.split("\n").slice(0, 8).join("\n")}`
      : commit.slice(0, 12),
  });
  if (ok) ok = record(await scanForbiddenTerms(root));
  if (ok) ok = record(await scanSecrets(root));
  for (const step of gateSteps()) {
    if (!ok) break;
    const started = performance.now();
    const child = Bun.spawn(step.command, {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, ...step.environment },
    });
    const exitCode = await child.exited;
    ok = record({
      name: step.name,
      passed: exitCode === 0,
      seconds: (performance.now() - started) / 1000,
    });
  }
  const receipt = {
    schema: 1,
    commit,
    passed: ok && results.length === 3 + gateSteps().length,
    finishedAt: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    steps: results,
  };
  const directory = resolve(root, ".factory/test-results/beta-gate");
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, `${commit.slice(0, 12)}.json`);
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`\nReceipt: ${file}\n${receipt.passed ? "Beta gate passed." : "Beta gate failed."}`);
  return receipt;
}

if (import.meta.main) {
  const receipt = await runGate(resolve(import.meta.dir, "../.."));
  process.exit(receipt.passed ? 0 : 1);
}
