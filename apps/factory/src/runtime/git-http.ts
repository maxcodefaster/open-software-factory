import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createForgejoClient } from "../../../../packages/forge/src/forge";

const sourceRoot = "/tmp/open-software-factory-runtime-sources";

export function runtimeSourcePath(attemptID: string) {
  return resolve(sourceRoot, attemptID);
}

export async function removeRuntimeRepository(attemptID: string) {
  await rm(runtimeSourcePath(attemptID), { recursive: true, force: true });
}

export function runtimeSourceCapability(attemptID: string) {
  const { FACTORY_AUTH_SECRET } = process.env;
  const secret = FACTORY_AUTH_SECRET ?? "local-development-secret-change-before-production";
  return createHmac("sha256", secret).update(`runtime-source:${attemptID}`).digest("hex");
}

export function validRuntimeSourceCapability(attemptID: string, candidate: string) {
  const expected = runtimeSourceCapability(attemptID);
  return (
    candidate.length === expected.length &&
    timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))
  );
}

export async function resolveRepositoryRevision(repositoryURL: string, branch: string) {
  if (!repositoryURL.startsWith("file://")) {
    const repository = configuredRepository(repositoryURL);
    const forge = createForgejoClient({ apiURL: repository.apiURL, token: repository.token });
    const current = await forge.getBranch(
      { owner: repository.owner, name: repository.name },
      branch,
    );
    if (!current) throw new Error("Project default branch is unavailable");
    return current.headSha;
  }
  const process = Bun.spawn(
    ["git", "ls-remote", "--exit-code", "--refs", repositoryURL, `refs/heads/${branch}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  const revision = output.trim().split(/\s+/)[0];
  if (exitCode !== 0 || !revision?.match(/^[0-9a-f]{40,64}$/)) {
    throw new Error(`Resolve Project revision: ${error || "branch not found"}`);
  }
  return revision;
}

export async function readRepositoryFileAtRevision(
  repositoryURL: string,
  revision: string,
  path: string,
) {
  const source = new URL(repositoryURL);
  if (
    source.protocol !== "file:" ||
    !/^[0-9a-f]{40,64}$/.test(revision) ||
    path.startsWith("/") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Repository file request is invalid");
  }
  const process = Bun.spawn(
    ["git", "-C", decodeURIComponent(source.pathname), "show", `${revision}:${path}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [content, error, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(error.trim() || `Repository file ${path} does not exist`);
  return content;
}

export async function prepareRuntimeRepository(
  attemptID: string,
  repositoryURL: string,
  revision: string,
) {
  const source = new URL(repositoryURL);
  if (source.protocol !== "file:") return repositoryURL;
  const destination = runtimeSourcePath(attemptID);
  await rm(destination, { recursive: true, force: true });
  await mkdir(sourceRoot, { recursive: true });
  for (const arguments_ of [
    ["clone", "--no-checkout", "--", decodeURIComponent(source.pathname), destination],
    ["-C", destination, "checkout", "--detach", revision],
  ]) {
    const process = Bun.spawn(["git", ...arguments_], { stdout: "ignore", stderr: "pipe" });
    const error = await new Response(process.stderr).text();
    if ((await process.exited) !== 0) throw new Error(`Prepare runtime source: ${error}`);
  }
  const status = Bun.spawn(["git", "-C", destination, "status", "--porcelain"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([
    new Response(status.stdout).text(),
    new Response(status.stderr).text(),
    status.exited,
  ]);
  if (code !== 0 || output.trim())
    throw new Error(`Runtime source checkout is not clean: ${error}`);
  return `file://${destination}`;
}

export async function serveRuntimeRepository(
  request: Request,
  repositoryURL: string,
  prefix: string,
) {
  const repository = new URL(repositoryURL);
  const requestURL = new URL(request.url);
  const requestedSuffix = requestURL.pathname.slice(prefix.length);
  if (
    !(
      (requestedSuffix === "/info/refs" &&
        request.method === "GET" &&
        requestURL.search === "?service=git-upload-pack") ||
      (requestedSuffix === "/git-upload-pack" &&
        request.method === "POST" &&
        requestURL.search === "")
    )
  )
    return new Response(null, { status: 403 });
  if (repository.protocol !== "file:") {
    const configured = configuredRepository(repositoryURL);
    const target = new URL(repositoryURL);
    target.pathname += requestedSuffix;
    target.search = requestURL.search;
    const response = await fetch(target, {
      method: request.method,
      headers: {
        authorization: `Basic ${Buffer.from(`factory:${configured.token}`).toString("base64")}`,
        "content-type":
          request.headers.get("content-type") ?? "application/x-git-upload-pack-request",
        ...(request.headers.has("content-encoding")
          ? { "content-encoding": request.headers.get("content-encoding")! }
          : {}),
        ...(request.headers.has("git-protocol")
          ? { "git-protocol": request.headers.get("git-protocol")! }
          : {}),
      },
      ...(request.method === "POST" ? { body: request.body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return new Response(null, { status: 503 });
    return new Response(response.body, {
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  }
  const repositoryPath = decodeURIComponent(repository.pathname);
  const url = new URL(request.url);
  const suffix = url.pathname.slice(prefix.length) || "/";
  const body = request.method === "GET" ? undefined : await request.arrayBuffer();
  const { HOME, PATH } = process.env;
  const child = Bun.spawn(["git", "http-backend"], {
    env: {
      PATH,
      HOME,
      GIT_PROJECT_ROOT: dirname(repositoryPath),
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${repositoryPath.split("/").at(-1)}${suffix}`,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers.get("content-type") ?? "",
      CONTENT_LENGTH: body ? String(body.byteLength) : "0",
      REMOTE_USER: "factory-runtime",
    },
    stdin: body ? new Uint8Array(body) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Git HTTP backend failed: ${error}`);
  const bytes = new Uint8Array(output);
  const divider = Buffer.from(bytes).indexOf("\r\n\r\n");
  if (divider < 0) throw new Error("Git HTTP backend returned no CGI headers");
  const headerText = Buffer.from(bytes.subarray(0, divider)).toString();
  const headers = new Headers();
  let status = 200;
  for (const line of headerText.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
    else headers.append(name, value);
  }
  return new Response(bytes.subarray(divider + 4), { status, headers });
}
function configuredRepository(repositoryURL: string) {
  const apiURL = process.env["FACTORY_FORGEJO_API_URL"];
  const token = process.env["FACTORY_FORGEJO_TOKEN"];
  const owner = process.env["FACTORY_FORGEJO_OWNER"];
  const url = new URL(repositoryURL);
  const parts = url.pathname
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (
    !apiURL ||
    !token ||
    !owner ||
    url.origin !== new URL(apiURL).origin ||
    url.username ||
    url.password ||
    parts.length !== 2 ||
    parts[0] !== owner ||
    !parts[1]
  )
    throw new Error("Project repository is outside the configured forge");
  return { apiURL, token, owner, name: parts[1] };
}
import { createHmac, timingSafeEqual } from "node:crypto";
