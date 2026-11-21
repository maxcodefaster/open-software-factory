import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runProcess } from "../owned-client-process";

// The local source, controller and UI gate. Native runtime and paid product
// acceptance remain separate explicit lanes, not implicit claims of this receipt.

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
    { name: "db-schema", command: ["bun", "run", "db:check"] },
    { name: "zero-schema", command: ["bun", "run", "zero:check"] },
    { name: "format", command: ["bun", "run", "format:check"] },
    { name: "lint", command: ["bun", "run", "lint"] },
    { name: "typecheck", command: ["bun", "run", "typecheck"] },
    { name: "unit", command: ["bun", "run", "test:unit"] },
    { name: "connector", command: ["bun", "run", "connector:check"] },
    { name: "substrate", command: ["bun", "run", "substrate:check"] },
    {
      name: "controllers",
      command: ["bun", "run", "test:controllers"],
      // The owned browsers in this lane start slowly while many databases run at once. One retry
      // per test absorbs that; a test that fails twice fails the gate.
      environment: { FACTORY_CONTROLLER_RETRIES: "1" },
    },
    {
      name: "browser",
      command: ["bun", "run", "test:browser"],
      // One retry absorbs a timing flake on a loaded machine. A spec that needs it is listed as
      // flaky in the run output; a spec that fails twice fails the gate.
      environment: { FACTORY_BROWSER_RETRIES: "1" },
    },
  ];
}

async function capture(command: string[], cwd: string, signal?: AbortSignal) {
  const result = await runProcess(command, { cwd, signal, allowFailure: true });
  return { ...result, exitCode: result.code };
}

type StepResult = {
  name: string;
  passed: boolean;
  seconds: number;
  detail?: string;
};

async function scanForbiddenTerms(root: string, signal?: AbortSignal): Promise<StepResult> {
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
  const files = (await capture(["git", "ls-files", "-z"], root, signal)).stdout
    .split("\0")
    .filter(Boolean);
  for (const file of files) {
    signal?.throwIfAborted();
    const content = await readFile(resolve(root, file), "utf8").catch(() => "");
    if (findForbidden(terms, `${file}\n${content}`).length) hits.push(file);
  }
  const history = (
    await capture(["git", "log", "--all", "-p", "--format=%H%n%an%n%ae%n%B"], root, signal)
  ).stdout;
  const historyHits = findForbidden(terms, history).length;
  const tags = findForbidden(
    terms,
    (await capture(["git", "tag", "-l"], root, signal)).stdout,
  ).length;
  return {
    name: "forbidden-terms",
    passed: hits.length === 0 && historyHits === 0 && tags === 0,
    seconds: (performance.now() - started) / 1000,
    detail: `${terms.length} terms; ${hits.length} files, ${historyHits} history matches, ${tags} tags${hits.length ? `: ${hits.slice(0, 5).join(", ")}` : ""}`,
  };
}

async function scanSecrets(root: string, signal?: AbortSignal): Promise<StepResult> {
  const started = performance.now();
  const parent = resolve(root, ".factory/test-results/beta-gate");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "scan-"));
  const owner = crypto.randomUUID();
  const name = `factory-gate-secrets-${owner}`;
  const label = "factory.gate-owner";
  let outcome: StepResult = {
    name: "secrets",
    passed: false,
    seconds: 0,
    detail: "Secret scan or its fresh report could not be confirmed",
  };
  try {
    const result = await capture(
      [
        "docker",
        "run",
        "--rm",
        "--name",
        name,
        "--label",
        `${label}=${owner}`,
        "--network",
        "none",
        "-v",
        `${root}:/repo:ro`,
        "-v",
        `${directory}:/out`,
        gitleaksImage,
        "detect",
        "--source",
        "/repo",
        "--log-opts=--all",
        "--no-banner",
        "--redact",
        "--exit-code",
        "3",
        "-r",
        "/out/gitleaks.json",
      ],
      root,
      signal,
    );
    if (![0, 3].includes(result.exitCode))
      throw new Error(`Secret scanner did not complete: exit ${result.exitCode}`);
    const report: unknown = JSON.parse(await readFile(resolve(directory, "gitleaks.json"), "utf8"));
    if (
      !Array.isArray(report) ||
      report.some(
        (finding) =>
          !finding ||
          typeof finding.RuleID !== "string" ||
          !finding.RuleID ||
          typeof finding.File !== "string" ||
          !finding.File,
      ) ||
      (result.exitCode === 0 ? report.length !== 0 : report.length === 0)
    )
      throw new Error("Secret scanner returned an inconsistent report");
    const findings = report as { RuleID: string; File: string }[];
    const allowed: unknown = JSON.parse(
      await readFile(resolve(root, "scripts/release/gitleaks-reviewed.json"), "utf8"),
    );
    if (!Array.isArray(allowed) || allowed.some((entry) => typeof entry !== "string"))
      throw new Error("Reviewed secret findings are invalid");
    const open = findings.filter(
      (finding) => !allowed.includes(`${finding.RuleID}:${finding.File}`),
    );
    outcome = {
      name: "secrets",
      passed: open.length === 0,
      seconds: (performance.now() - started) / 1000,
      detail: `${findings.length} findings, ${open.length} not reviewed`,
    };
  } catch {
    outcome.passed = false;
  }
  try {
    if (signal?.aborted) {
      const observed = await capture(
        ["docker", "inspect", "--format", `{{index .Config.Labels "${label}"}}`, name],
        root,
        AbortSignal.timeout(5000),
      );
      if (observed.exitCode === 0) {
        if (observed.stdout.trim() !== owner)
          throw new Error("Secret scanner cleanup ownership changed");
        const removed = await capture(
          ["docker", "rm", "--force", name],
          root,
          AbortSignal.timeout(5000),
        );
        if (removed.exitCode !== 0) throw new Error("Secret scanner cleanup is unconfirmed");
      } else if (observed.stderr.trim().toLowerCase() !== `error: no such object: ${name}`) {
        throw new Error("Secret scanner cleanup could not be observed");
      }
    }
  } catch {
    outcome.passed = false;
    outcome.detail = "Secret scan failed or was interrupted; scanner cleanup is unconfirmed";
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  outcome.seconds = (performance.now() - started) / 1000;
  return outcome;
}

export async function runGate(root: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const status = await capture(["git", "status", "--porcelain"], root, signal);
  const head = await capture(["git", "rev-parse", "HEAD"], root, signal);
  const commit = head.stdout.trim();
  const validSource = status.exitCode === 0 && head.exitCode === 0 && /^[a-f0-9]{40}$/.test(commit);
  const overrides = ["FACTORY_BROWSER_BASE_URL", "FACTORY_BUILD_DIRECTORY"].filter(
    (name) => process.env[name],
  );
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
    passed: validSource && status.stdout.trim() === "" && overrides.length === 0,
    seconds: 0,
    detail: !validSource
      ? "Source identity could not be confirmed"
      : overrides.length
        ? `Unbound test artifacts: ${overrides.join(", ")}`
        : status.stdout.trim()
          ? "Source has uncommitted changes"
          : commit.slice(0, 12),
  });
  if (ok) ok = record(await scanForbiddenTerms(root, signal));
  if (ok) ok = record(await scanSecrets(root, signal));
  for (const step of gateSteps()) {
    if (!ok) break;
    const started = performance.now();
    const result = await runProcess(step.command, {
      cwd: root,
      output: "inherit",
      env: { ...process.env, ...step.environment },
      signal,
      allowFailure: true,
    });
    ok = record({
      name: step.name,
      passed: result.code === 0,
      seconds: (performance.now() - started) / 1000,
    });
  }
  if (ok) {
    const finalStatus = await capture(["git", "status", "--porcelain"], root, signal);
    const finalHead = await capture(["git", "rev-parse", "HEAD"], root, signal);
    if (
      finalStatus.exitCode !== 0 ||
      finalHead.exitCode !== 0 ||
      finalStatus.stdout.trim() ||
      finalHead.stdout.trim() !== commit
    ) {
      ok = false;
      const source = results[0];
      if (source) {
        source.passed = false;
        source.detail = "Source changed during verification or its identity became unavailable";
      }
      console.log("FAIL  clean-tree  Source could not be reconfirmed after verification");
    }
  }
  signal?.throwIfAborted();
  const receipt = {
    schema: 1,
    scope: "source-controller-ui",
    nativeProductAcceptance: false,
    commit,
    passed: ok && results.length === 3 + gateSteps().length,
    finishedAt: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    steps: results,
  };
  const directory = resolve(root, ".factory/test-results/beta-gate");
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, `${validSource ? commit.slice(0, 12) : "unconfirmed"}.json`);
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`\nReceipt: ${file}\n${receipt.passed ? "Beta gate passed." : "Beta gate failed."}`);
  return receipt;
}

if (import.meta.main) {
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort("SIGINT");
  const terminate = () => cancellation.abort("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const receipt = await runGate(resolve(import.meta.dir, "../.."), cancellation.signal);
    process.exitCode = receipt.passed ? 0 : 1;
  } catch {
    console.error(cancellation.signal.aborted ? "Beta gate interrupted." : "Beta gate failed.");
    process.exitCode =
      cancellation.signal.reason === "SIGINT"
        ? 130
        : cancellation.signal.reason === "SIGTERM"
          ? 143
          : 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
