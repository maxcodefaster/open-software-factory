import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("the native TLS proxy does not preempt bounded quiet work or widen its network access", async () => {
  const lines = (await Bun.file("deploy/substrate/rootless/tinyproxy.conf").text())
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  expect(lines.filter((line) => line.startsWith("Timeout "))).toEqual(["Timeout 900"]);
  expect(lines.filter((line) => line.startsWith("ConnectPort ")).sort()).toEqual([
    "ConnectPort 443",
    "ConnectPort 80",
  ]);
  expect(lines.filter((line) => line.startsWith("Allow "))).toEqual([
    "Allow 127.0.0.1",
    "Allow 10.0.2.0/24",
    "Allow 172.16.0.0/12",
  ]);
  expect(lines).toContain("MaxClients 32");
});

async function readiness(kind: string, readyAfter: number, mode = "docker", diesAfter = -1) {
  const child = Bun.spawn(
    [
      "python3",
      "-c",
      `
import json,os,runpy,subprocess,sys,time
clock=[0.0]
commands=[]
kind,after,mode,dies,path=sys.argv[1:]
after=float(after);dies=float(dies)
time.monotonic=lambda:clock[0]
def sleep(duration):clock[0]+=duration
time.sleep=sleep
def alive(pid,signal):
 assert pid==12345 and signal==0
 if dies>=0 and clock[0]>=dies:raise ProcessLookupError("original daemon exited")
os.kill=alive
def run(command,**options):
 commands.append(command)
 assert options=={"capture_output":True,"timeout":5}
 ready=after>=0 and clock[0]>=after
 return subprocess.CompletedProcess(command,0 if ready else 1,
  (mode+"\\n").encode() if kind=="bootstrap" else b"Server: ready",b"")
subprocess.run=run
sys.argv=[path,kind,"12345"]
error=None
try:runpy.run_path(path,run_name="__main__")
except (SystemExit,ProcessLookupError) as cause:error=str(cause)
print(json.dumps({"elapsed":clock[0],"error":error,"command":commands[0] if commands else None}))
`,
      kind,
      String(readyAfter),
      mode,
      String(diesAfter),
      resolve("deploy/substrate/rootless/wait.py"),
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, error).toBe(0);
  const result = output.trim().split("\n").at(-1);
  if (!result) throw new Error("Readiness fixture returned no result");
  return JSON.parse(result) as {
    elapsed: number;
    error: string | null;
    command: string[] | null;
  };
}

for (const mode of ["docker", "input-stop"])
  test(`cold ${mode} admission can finish a live Source import after ordinary Docker readiness`, async () => {
    const result = await readiness("bootstrap", 160, mode);
    expect(result.error).toBeNull();
    expect(result.elapsed).toBe(160);
    expect(result.command).toEqual([
      "/usr/local/bin/factory-runtime-connector",
      "native-bootstrap-mode",
    ]);
  });

test("cold admission remains bounded by the pinned native five-minute wakeup window", async () => {
  const result = await readiness("bootstrap", -1);
  expect(result.error).toBe("Private bootstrap readiness deadline exceeded");
  expect(result.elapsed).toBe(300);
});

test("ordinary private Docker readiness retains its shorter existing deadline", async () => {
  const result = await readiness("docker", 160);
  expect(result.error).toBe("Private docker readiness deadline exceeded");
  expect(result.elapsed).toBe(150);
  expect(result.command).toEqual(["docker", "info"]);
});

test("cold admission still refuses another mode and the original daemon exiting", async () => {
  expect((await readiness("bootstrap", 0, "unconfirmed")).error).toBe(
    "Native cold mode is invalid",
  );
  expect((await readiness("bootstrap", 160, "docker", 20)).error).toBe("original daemon exited");
});
