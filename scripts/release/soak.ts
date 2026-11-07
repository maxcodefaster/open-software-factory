import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// The beta soak: a long run on one installation that cycles Preview open, idle pause,
// resume, a Wiki update and a backup, and stops at the first error nobody allowed.

export type SoakPlan = {
  cycle: number;
  wiki: boolean;
  backup: boolean;
  journey: boolean;
};

/** One cycle every `intervalMinutes`. Wiki and backup hourly, one Ticket journey per six hours. */
export function planCycle(cycle: number, intervalMinutes: number): SoakPlan {
  const perHour = Math.max(1, Math.round(60 / intervalMinutes));
  return {
    cycle,
    wiki: cycle % perHour === 0,
    backup: cycle % perHour === 0,
    journey: cycle > 0 && cycle % (perHour * 6) === 0,
  };
}

/** Log lines that mean trouble unless the allowlist names them. */
export function unallowedLogLines(log: string, allowed: readonly RegExp[]) {
  return log
    .split("\n")
    .filter((line) => /\b(error|fatal|panic|unhandled|exception)\b|failed:/i.test(line))
    .filter((line) => !allowed.some((pattern) => pattern.test(line)));
}

export type Baseline = { restarts: number; workerPod: string };

export function healthViolations(input: {
  baseline: Baseline;
  restarts: number;
  workerPod: string;
  workerPhase: string;
  badAttempts: number;
  freeDiskGiB: number;
}) {
  const violations: string[] = [];
  if (input.restarts > input.baseline.restarts)
    violations.push(`Factory restarted ${input.restarts - input.baseline.restarts} time(s)`);
  if (input.workerPod !== input.baseline.workerPod)
    violations.push(
      `The worker Pod changed from ${input.baseline.workerPod} to ${input.workerPod}`,
    );
  if (input.workerPhase !== "Running") violations.push(`The worker is ${input.workerPhase}`);
  if (input.badAttempts > 0)
    violations.push(`${input.badAttempts} runtime attempt(s) failed or need cleanup`);
  if (input.freeDiskGiB < 10) violations.push(`Only ${input.freeDiskGiB} GiB of disk are free`);
  return violations;
}

type Options = {
  hours: number;
  intervalMinutes: number;
  namespace: string;
  release: string;
  context: string;
  workerNamespace: string;
  uiCycle: string;
  wikiCommand: string | undefined;
  journeyCommand: string | undefined;
  allowFile: string | undefined;
  output: string;
};

async function sh(command: string[], cwd?: string) {
  const child = Bun.spawn(command, { ...(cwd ? { cwd } : {}), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function main(options: Options) {
  mkdirSync(options.output, { recursive: true });
  const log = resolve(options.output, "soak.jsonl");
  const kubectl = (...args: string[]) => ["kubectl", "--context", options.context, ...args];
  const psql = async (query: string) =>
    (
      await sh(
        kubectl(
          "-n",
          options.namespace,
          "exec",
          `${options.release}-postgres-0`,
          "--",
          "psql",
          "-U",
          "factory",
          "-d",
          "factory",
          "-At",
          "-c",
          query,
        ),
      )
    ).stdout.trim();
  const allowed = options.allowFile
    ? (await Bun.file(options.allowFile).text())
        .split("\n")
        .filter((line) => line.trim() && !line.startsWith("#"))
        .map((line) => new RegExp(line))
    : [];
  const record = (entry: Record<string, unknown>) => {
    const line = { at: new Date().toISOString(), ...entry };
    appendFileSync(log, `${JSON.stringify(line)}\n`);
    console.log(JSON.stringify(line));
  };
  const factoryRestarts = async () =>
    Number(
      (
        await sh(
          kubectl(
            "-n",
            options.namespace,
            "get",
            "pods",
            "-l",
            "app.kubernetes.io/name=factory",
            "-o",
            "jsonpath={.items[0].status.containerStatuses[0].restartCount}",
          ),
        )
      ).stdout || 0,
    );
  const worker = async () => {
    const out = (
      await sh(
        kubectl(
          "-n",
          options.workerNamespace,
          "get",
          "pods",
          "-l",
          "factory.dev/factorybox-worker",
          "--field-selector=status.phase=Running",
          "-o",
          "jsonpath={.items[0].metadata.name} {.items[0].status.phase}",
        ),
      )
    ).stdout.trim();
    const [name = "", phase = "Missing"] = out.split(" ");
    return { name, phase };
  };
  const baselineWorker = await worker();
  const baseline: Baseline = { restarts: await factoryRestarts(), workerPod: baselineWorker.name };
  // A failed image prebuild falls back to normal startup by design. The starter app's Compose
  // file needs Environment values, so its prebuild can never succeed. Failed cleanup still counts.
  const badBaseline = Number(
    await psql(
      "select count(*) from factory.runtime_attempt where state='cleanup-failed' or (state='failed' and isolated_kind is distinct from 'prebuild')",
    ),
  );
  record({
    event: "start",
    baseline,
    hours: options.hours,
    intervalMinutes: options.intervalMinutes,
  });
  const deadline = Date.now() + options.hours * 3_600_000;
  let lastLog = new Date().toISOString();
  let cycle = 0;
  const abort = (reason: string, detail?: unknown) => {
    record({ event: "abort", cycle, reason, detail });
    writeFileSync(
      resolve(options.output, "receipt.json"),
      `${JSON.stringify({ schema: 1, passed: false, cycles: cycle, reason, detail }, null, 2)}\n`,
    );
    process.exit(1);
  };
  while (Date.now() < deadline) {
    const started = Date.now();
    const plan = planCycle(cycle, options.intervalMinutes);
    const disk = Number(
      (await sh(["df", "-g", "/"])).stdout.split("\n")[1]?.split(/\s+/)[3] ??
        Number.POSITIVE_INFINITY,
    );
    const now = await worker();
    const bad = Number(
      await psql(
        "select count(*) from factory.runtime_attempt where state='cleanup-failed' or (state='failed' and isolated_kind is distinct from 'prebuild')",
      ),
    );
    const violations = healthViolations({
      baseline,
      restarts: await factoryRestarts(),
      workerPod: now.name,
      workerPhase: now.phase,
      badAttempts: bad - badBaseline,
      freeDiskGiB: Number.isFinite(disk) ? disk : 1000,
    });
    if (violations.length) abort("health", violations);
    const ui = await sh(["bun", options.uiCycle]);
    record({ event: "ui", cycle, exitCode: ui.exitCode, output: ui.stdout.slice(-600) });
    if (ui.exitCode !== 0) abort("ui-cycle", (ui.stdout + ui.stderr).slice(-1200));
    if (plan.wiki && options.wikiCommand) {
      const wiki = await sh(["sh", "-c", options.wikiCommand]);
      record({ event: "wiki", cycle, exitCode: wiki.exitCode, output: wiki.stdout.slice(-400) });
      if (wiki.exitCode !== 0) abort("wiki", (wiki.stdout + wiki.stderr).slice(-1200));
    }
    if (plan.backup) {
      const job = `soak-backup-${cycle}`;
      await sh(
        kubectl(
          "-n",
          options.namespace,
          "create",
          "job",
          job,
          `--from=cronjob/${options.release}-backup`,
        ),
      );
      const done = await sh(
        kubectl(
          "-n",
          options.namespace,
          "wait",
          "--for=condition=complete",
          `job/${job}`,
          "--timeout=900s",
        ),
      );
      record({ event: "backup", cycle, exitCode: done.exitCode });
      if (done.exitCode !== 0) abort("backup", done.stderr.slice(-600));
      await sh(kubectl("-n", options.namespace, "delete", "job", job));
    }
    if (plan.journey && options.journeyCommand) {
      const journey = await sh(["sh", "-c", options.journeyCommand]);
      record({
        event: "journey",
        cycle,
        exitCode: journey.exitCode,
        output: journey.stdout.slice(-400),
      });
      if (journey.exitCode !== 0) abort("journey", (journey.stdout + journey.stderr).slice(-1200));
    }
    const logs = await sh(
      kubectl(
        "-n",
        options.namespace,
        "logs",
        `deploy/${options.release}`,
        "-c",
        "factory",
        `--since-time=${lastLog}`,
      ),
    );
    lastLog = new Date().toISOString();
    const trouble = unallowedLogLines(logs.stdout + logs.stderr, allowed);
    if (trouble.length) abort("log", trouble.slice(0, 8));
    record({ event: "cycle", cycle, plan, seconds: Math.round((Date.now() - started) / 1000) });
    cycle++;
    const wait = options.intervalMinutes * 60_000 - (Date.now() - started);
    if (wait > 0) await Bun.sleep(wait);
  }
  writeFileSync(
    resolve(options.output, "receipt.json"),
    `${JSON.stringify({ schema: 1, passed: true, cycles: cycle, hours: options.hours, finishedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  record({ event: "passed", cycles: cycle });
}

if (import.meta.main) {
  const arg = (name: string, fallback?: string) => {
    const index = process.argv.indexOf(`--${name}`);
    const value = index >= 0 ? process.argv[index + 1] : fallback;
    if (value === undefined) throw new Error(`Missing --${name}`);
    return value;
  };
  await main({
    hours: Number(arg("hours", "24")),
    intervalMinutes: Number(arg("interval", "20")),
    namespace: arg("namespace"),
    release: arg("release"),
    context: arg("context", "orbstack"),
    workerNamespace: arg("worker-namespace"),
    uiCycle: arg("ui-cycle"),
    wikiCommand: process.argv.includes("--wiki") ? arg("wiki") : undefined,
    journeyCommand: process.argv.includes("--journey") ? arg("journey") : undefined,
    allowFile: process.argv.includes("--allow") ? arg("allow") : undefined,
    output: resolve(arg("output", ".factory/test-results/soak")),
  });
}
