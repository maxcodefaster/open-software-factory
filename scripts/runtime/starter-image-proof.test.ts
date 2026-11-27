import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import imagePins from "../../deploy/helm/factory/image-pins.json";
import upstream from "../../upstream.json";

test("Starter package proof runs the recipe's non-root user and exact versions without network or a server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-starter-image-proof-"));
  const calls = join(directory, "calls");
  const image = `sha256:${"a".repeat(64)}`;
  const pgVersion = /postgres:([\d.]+)-/.exec(imagePins.postgres)?.[1];
  expect(pgVersion).toBeDefined();
  try {
    const commands = {
      docker: `#!/bin/bash
set -e
printf '%s\\n' "$*" >> "$OWNED_CALLS"
if [[ "$1" == image ]]; then printf '%s\\n' "$OWNED_PLATFORM"; exit 0; fi
if [[ "$1" == version ]]; then printf '%s\\n' "$OWNED_HOST_PLATFORM"; exit 0; fi
if [[ "$1 $2" == "container inspect" ]]; then cat "$OWNED_STATE"; exit 0; fi
if [[ "$1" == rm ]]; then
  test "$*" = "rm --force --volumes $OWNED_CONTAINER"
  rm "$OWNED_STATE"
  exit 0
fi
test "$1" = run
shift
while [[ "$#" -gt 0 && "$1" != "$OWNED_IMAGE" ]]; do
  if [[ "$1" == --env ]]; then export "$2"; shift; fi
  if [[ "$1" == --label ]]; then owner="\${2#*=}"; shift; fi
  if [[ "$1" == --cidfile ]]; then cid="$2"; shift; fi
  shift
done
test "$1" = "$OWNED_IMAGE"
printf '%s\\n' "$OWNED_CONTAINER" > "$cid"
printf '%s %s\\n' "$OWNED_CONTAINER" "$owner" > "$OWNED_STATE"
shift
exec /bin/sh "$@"
`,
      id: `#!/bin/sh
set -e
case "$1:$2" in
  -u:postgres) printf '999\\n' ;;
  -g:postgres) printf '999\\n' ;;
  -u:) printf '%s\\n' "$OWNED_UID" ;;
  -g:) printf '%s\\n' "$OWNED_GID" ;;
  *) exit 90 ;;
esac
`,
      node: `#!/bin/sh
set -e
test "$1" = --version
printf 'v%s\\n' "$OWNED_NODE_VERSION"
`,
      git: `#!/bin/sh
set -e
test "$1" = --version
test "$OWNED_FAILURE" != git
printf 'git version 2.39.5\\n'
`,
      postgres: `#!/bin/sh
set -e
test "$1" = --version
test "$OWNED_FAILURE" != postgres
printf 'postgres (PostgreSQL) %s (Debian owned-fixture)\\n' "$OWNED_PG_VERSION"
`,
    };
    for (const [name, content] of Object.entries(commands))
      await writeFile(join(directory, name), content, { mode: 0o700 });
    for (const role of ["starter-work", "starter-postgres"]) {
      for (const architecture of ["arm64", "amd64"]) {
        for (const failure of [
          "",
          "host",
          "root",
          "uid",
          "gid",
          "version",
          ...(role === "starter-work" ? ["git"] : ["postgres"]),
        ]) {
          await writeFile(calls, "");
          const uid = role === "starter-work" ? "1000" : "999";
          const child = Bun.spawn(["bash", "scripts/runtime/starter-image-proof.sh", image, role], {
            env: {
              ...process.env,
              PATH: `${directory}:${process.env["PATH"]}`,
              OWNED_CALLS: calls,
              OWNED_IMAGE: image,
              OWNED_CONTAINER: "c".repeat(64),
              OWNED_STATE: join(directory, "state"),
              OWNED_PLATFORM: `linux/${architecture}`,
              OWNED_HOST_PLATFORM: failure === "host" ? "linux/riscv64" : `linux/${architecture}`,
              OWNED_UID: failure === "root" ? "0" : failure === "uid" ? "1001" : uid,
              OWNED_GID: failure === "gid" ? "1001" : uid,
              OWNED_NODE_VERSION:
                failure === "version" ? "0.0.0" : upstream.nodeDevelopment.version,
              OWNED_PG_VERSION: failure === "version" ? "0.0" : pgVersion,
              OWNED_FAILURE: failure,
            },
            stdout: "pipe",
            stderr: "pipe",
          });
          const [code, output, error] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect(code, `${role}/${architecture}/${failure}: ${error}`).toBe(failure ? 1 : 0);
          const observed = await readFile(calls, "utf8");
          if (failure === "host") expect(observed).not.toContain("run ");
          else {
            for (const flag of [
              "--network=none",
              "--read-only",
              "--cap-drop=ALL",
              "--security-opt=no-new-privileges",
              "--cpus=1",
              "--memory=256m",
              `--entrypoint /bin/sh ${image} -ec`,
              "--pull=never",
              "--label factory.starter-image-proof=",
              "--cidfile",
            ])
              expect(observed).toContain(flag);
            // An override would hide a regression of the recipe's configured USER.
            expect(observed).not.toMatch(/--user|--privileged|--volume\b|--mount|initdb|pg_ctl/);
            expect(observed).toContain(`rm --force --volumes ${"c".repeat(64)}`);
          }
          if (failure) expect(output).toBe("");
          else {
            expect(JSON.parse(output)).toEqual({
              starterImagePackages: true,
              role,
              platform: `linux/${architecture}`,
              version: role === "starter-work" ? upstream.nodeDevelopment.version : pgVersion,
              nativeActorLifecycle: false,
            });
          }
        }
      }
    }
    const syntax = Bun.spawn(["bash", "-n", "scripts/runtime/starter-image-proof.sh"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await syntax.exited).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// The CLI and daemon state are separate: killing this owned subprocess leaves
// its simulated container/anonymous volume until the real proof trap removes it.
const ownedProofDocker = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
const args=process.argv.slice(2), root=process.env.OWNED_PROOF_ROOT, mode=process.env.OWNED_PROOF_MODE;
appendFileSync(root+"/calls", JSON.stringify(args)+"\\n");
const state=root+"/state", saved=existsSync(state)?JSON.parse(readFileSync(state,"utf8")):null;
if(args[0]==="image" || args[0]==="version") console.log("linux/arm64");
else if(args[0]==="run") {
  const owner=args[args.indexOf("--label")+1].split("=")[1];
  const name=args[args.indexOf("--name")+1], id="c".repeat(64);
  writeFileSync(root+"/pid", String(process.pid));
  if(mode!=="before-create") {
    writeFileSync(state, JSON.stringify({id,owner,name,anonymousVolume:true}));
    if(mode!=="before-cid") writeFileSync(args[args.indexOf("--cidfile")+1], id+"\\n");
  }
  writeFileSync(root+"/ready","1");
  if(mode==="exit23") process.exit(23);
  if(mode==="exit0" || mode==="remove-failure") process.exit(0);
  setInterval(()=>{},1000);
} else if(args[0]==="container" && args[1]==="inspect") {
  if(mode==="unavailable") {console.error("daemon unavailable");process.exit(1);}
  if(!saved) {console.error("Error: No such container: "+args.at(-1));process.exit(1);}
  console.log((mode==="foreign-cid"?"d".repeat(64):saved.id)+" "+(mode==="foreign-owner"?"foreign":saved.owner));
} else if(args[0]==="rm") {
  if(mode==="remove-failure") {console.error("owned removal failed");process.exit(1);}
  if(args.join(" ")!=="rm --force --volumes "+saved.id) process.exit(92);
  unlinkSync(state);
} else process.exit(91);
`;

async function ownedProof(mode: string) {
  const directory = await mkdtemp(join(tmpdir(), "factory-starter-proof-lifetime-"));
  await writeFile(join(directory, "docker"), ownedProofDocker, { mode: 0o700 });
  const child = Bun.spawn(
    [
      "bash",
      "scripts/runtime/starter-image-proof.sh",
      `sha256:${"a".repeat(64)}`,
      "starter-postgres",
    ],
    {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env["PATH"]}`,
        OWNED_PROOF_ROOT: directory,
        OWNED_PROOF_MODE: mode,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    child,
    output,
    directory,
    async ready() {
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        if (await readFile(join(directory, "ready"), "utf8").catch(() => "")) return;
        if (child.exitCode !== null) throw Error("Proof exited before its owned CLI started");
        await Bun.sleep(10);
      }
      throw Error("Proof did not start its owned CLI");
    },
    async calls() {
      return (await readFile(join(directory, "calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
    },
    async joined() {
      const pid = Number(await readFile(join(directory, "pid"), "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    },
    async dispose() {
      if (child.exitCode === null) child.kill("SIGKILL");
      const pid = Number(await readFile(join(directory, "pid"), "utf8").catch(() => "0"));
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await child.exited;
      await output;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const [signal, code] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
] as const) {
  test(`Starter proof ${signal} removes only its owned CID and anonymous volumes and joins the CLI`, async () => {
    const f = await ownedProof("run");
    try {
      await f.ready();
      f.child.kill(signal);
      expect(await f.child.exited).toBe(code);
      const calls = await f.calls();
      const run = calls.find((args) => args[0] === "run");
      expect(run?.[(run?.indexOf("--name") ?? -1) + 1]).toMatch(
        /^factory-starter-image-proof-[a-f0-9]{32}$/,
      );
      expect(calls).toContainEqual(["rm", "--force", "--volumes", "c".repeat(64)]);
      expect(await readFile(join(f.directory, "state"), "utf8").catch(() => "")).toBe("");
      expect((await f.output)[0]).toBe("");
      await f.joined();
    } finally {
      await f.dispose();
    }
  }, 15_000);
}

for (const mode of ["foreign-owner", "foreign-cid", "unavailable"]) {
  test(`Starter proof cancellation refuses unsafe cleanup on ${mode}`, async () => {
    const f = await ownedProof(mode);
    try {
      await f.ready();
      f.child.kill("SIGTERM");
      expect(await f.child.exited).toBe(1);
      expect((await f.calls()).some((args) => args[0] === "rm")).toBe(false);
      expect((await f.output)[0]).toBe("");
      await f.joined();
    } finally {
      await f.dispose();
    }
  }, 15_000);
}

for (const mode of ["before-create", "before-cid"]) {
  test(`Starter proof interrupted ${mode} remains incomplete and never loses its owned CLI`, async () => {
    const f = await ownedProof(mode);
    try {
      await f.ready();
      f.child.kill("SIGTERM");
      expect(await f.child.exited).toBe(143);
      const calls = await f.calls();
      if (mode === "before-cid")
        expect(calls).toContainEqual(["rm", "--force", "--volumes", "c".repeat(64)]);
      else expect(calls.some((args) => args[0] === "rm")).toBe(false);
      expect((await f.output)[0]).toBe("");
      await f.joined();
    } finally {
      await f.dispose();
    }
  }, 15_000);
}

for (const [mode, code] of [
  ["exit23", 23],
  ["remove-failure", 1],
] as const) {
  test(`Starter proof ${mode} cannot emit a successful package receipt`, async () => {
    const f = await ownedProof(mode);
    try {
      expect(await f.child.exited).toBe(code);
      expect((await f.calls()).some((args) => args[0] === "rm")).toBe(true);
      expect((await f.output)[0]).toBe("");
      await f.joined();
    } finally {
      await f.dispose();
    }
  }, 15_000);
}

test("Starter package proof refuses mutable IDs, other roles and unsupported platforms before execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-starter-image-input-"));
  const calls = join(directory, "calls");
  try {
    await writeFile(
      join(directory, "docker"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$OWNED_CALLS"
test "$1" = image || exit 91
printf 'linux/riscv64\\n'
`,
      { mode: 0o700 },
    );
    for (const [image, role, inspections] of [
      ["starter:latest", "starter-work", 0],
      [`sha256:${"a".repeat(64)}`, "browser-tools", 0],
      [`sha256:${"a".repeat(64)}`, "starter-work", 1],
    ] as const) {
      await writeFile(calls, "");
      const child = Bun.spawn(["bash", "scripts/runtime/starter-image-proof.sh", image, role], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env["PATH"]}`,
          OWNED_CALLS: calls,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, output] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(1);
      expect(output).toBe("");
      const observed = (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean);
      expect(observed, `${role}/${image}: ${observed.join("; ")}`).toHaveLength(inspections);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
