// Admission for restore verification only. Never fetch, inspect a checkout, or run source code.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execute = promisify(execFile);
const revisionPattern = /^[a-f0-9]{40}$/;
const chartRoot = "deploy/helm/factory";

export const reviewedRestoreContract = Object.freeze({
  revision: "0a6800a0871bf9c8bc9f09f7c19e7160deacb0c1",
  chart: "66ee75748e01f963fa94bb73dc470cd2149a29a5b2d2af42576a0c4f99abfc18",
  application: "a3faa3161c75baf61f8b57d4f12e31dda938cf607871eadae84bf4d72abbf981",
});

// Exact paths only. No extension, directory, test-name or README glob can hide new code.
// The Helm preflight templates and backup scripts are production files, not exclusions.
const chartExclusions = new Set(["deploy/helm/factory/README.md"]);
const applicationExclusions = new Set([
  // Human documentation. Runtime instructions in deploy/opencode-server/config/AGENTS.md
  // and public assets remain hashed, even when they happen to be Markdown.
  "AGENTS.md",
  "README.md",
  "SECURITY.md",
  "deploy/substrate/README.md",
  "scripts/runtime/README.md",
  "services/substrate-control/README.md",
  "templates/release/README.md",
  "templates/starter-app/README.md",
  "test/fixtures/runtime-project/README.md",
  // Explicit operator-invoked restore verification tools, never an application entrypoint.
  // Shared clients, backup production code and every other test/tool remain hashed.
  "scripts/kubernetes/restore-check.ts",
  "scripts/kubernetes/restore-check.test.ts",
  "scripts/kubernetes/restore-rehearsal.ts",
  "scripts/kubernetes/restore-rehearsal.test.ts",
  "scripts/kubernetes/restore-application-check.ts",
  "scripts/kubernetes/restore-application-check.test.ts",
  "scripts/kubernetes/restore-zero-projects.ts",
  "scripts/kubernetes/restore-zero-projects.test.ts",
  "scripts/kubernetes/restore-source-contract.ts",
  "scripts/kubernetes/restore-source-contract.test.ts",
]);

type Contract = "chart" | "application";
type Entry = { mode: string; oid: string; path: string };

async function git(repository: string, args: string[], input?: string) {
  const pending = execute(
    "git",
    [
      "--no-replace-objects",
      "--no-lazy-fetch",
      "--no-optional-locks",
      "-c",
      "protocol.allow=never",
      "-c",
      "core.fsmonitor=false",
      "-C",
      repository,
      ...args,
    ],
    {
      // Do not inherit GIT_DIR, config injection, replacement refs or fetch credentials.
      env: {
        PATH: process.env["PATH"] ?? "",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  // execFile has no input option. Close stdin even for commands that do not consume it.
  pending.child.stdin?.on("error", () => {});
  pending.child.stdin?.end(input);
  return (await pending).stdout;
}

function entries(bytes: Buffer): Entry[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\0")) throw Error("Incomplete committed source inventory");
  return text
    .slice(0, -1)
    .split("\0")
    .map((line) => {
      const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t([^\0\r\n]+)$/.exec(line);
      if (!match) throw Error("Unsupported committed source entry");
      const [, mode, oid, path] = match;
      if (!mode || !oid || !path) throw Error("Incomplete committed source entry");
      return { mode, oid, path };
    })
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

/** SHA-256 of committed path, mode and raw-blob SHA-256 records, not Git SHA-1 alone. */
export async function restoreContractDigest(
  repository: string,
  revision: string,
  contract: Contract,
): Promise<string> {
  if (!revisionPattern.test(revision)) throw Error("An exact lowercase commit SHA is required");
  if ((await git(repository, ["cat-file", "-t", revision])).toString().trim() !== "commit")
    throw Error("Restore source must name a local commit object");
  const inventory = entries(await git(repository, ["ls-tree", "-rz", "--full-tree", revision]));
  const selected = inventory.filter((entry) => {
    const chart = entry.path === chartRoot || entry.path.startsWith(`${chartRoot}/`);
    if (chart !== (contract === "chart")) return false;
    if (!(contract === "chart" ? chartExclusions : applicationExclusions).has(entry.path))
      return true;
    if (entry.mode !== "100644") throw Error("Excluded source path is not a regular text file");
    return false;
  });
  if (!selected.length) throw Error("Committed source contract is empty");
  // A single bounded local read. Batch input contains object IDs, never paths or revision syntax.
  const blobs = await git(
    repository,
    ["cat-file", "--batch"],
    `${selected.map((entry) => entry.oid).join("\n")}\n`,
  );
  const digest = createHash("sha256").update(`factory-restore-source-contract-v1\0${contract}\0`);
  let offset = 0;
  for (const entry of selected) {
    const end = blobs.indexOf(10, offset);
    if (end < 0) throw Error("Incomplete committed source object");
    const header = blobs.subarray(offset, end).toString("ascii");
    const match = /^([a-f0-9]{40}) blob (0|[1-9][0-9]*)$/.exec(header);
    const size = Number(match?.[2]);
    offset = end + 1;
    if (
      match?.[1] !== entry.oid ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + size >= blobs.length ||
      blobs[offset + size] !== 10
    )
      throw Error("Missing or invalid committed source blob");
    const content = createHash("sha256")
      .update(blobs.subarray(offset, offset + size))
      .digest("hex");
    digest.update(`${JSON.stringify([entry.mode, entry.path, content])}\n`);
    offset += size + 1;
  }
  if (offset !== blobs.length) throw Error("Unexpected committed source objects");
  return digest.digest("hex");
}

export async function matchesRestoreSourceContract(
  repository: string,
  chartRevision: string,
  applicationRevision: string,
): Promise<boolean> {
  // Validate both before spawning any command. Tags, branches, abbreviations and rev syntax fail.
  if (!revisionPattern.test(chartRevision) || !revisionPattern.test(applicationRevision))
    return false;
  try {
    return (
      (await restoreContractDigest(repository, chartRevision, "chart")) ===
        reviewedRestoreContract.chart &&
      (await restoreContractDigest(repository, applicationRevision, "application")) ===
        reviewedRestoreContract.application
    );
  } catch {
    // Missing commits/blobs, unsupported entries, size/time bounds and Git failures all refuse.
    return false;
  }
}
