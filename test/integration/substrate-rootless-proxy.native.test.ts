import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

test("packaged Tinyproxy preserves a 35-second quiet verified-TLS response", async () => {
  const image = process.env["FACTORY_SUBSTRATE_PROXY_TEST_IMAGE"];
  if (!image || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image))
    throw Error("FACTORY_SUBSTRATE_PROXY_TEST_IMAGE must name an explicit cached image digest");
  const owner = crypto.randomUUID();
  const name = `factory-rootless-proxy-${owner}`;
  const label = "factory.rootless-proxy-proof";
  const directory = resolve(
    process.env["FACTORY_SUBSTRATE_PROXY_TEST_RESULTS"] ??
      ".factory/test-results/substrate-rootless-proxy",
    owner,
  );
  await mkdir(resolve(directory, ".."), { recursive: true });
  await mkdir(directory, { mode: 0o700 });
  const record: Record<string, unknown> = {
    at: new Date().toISOString(),
    owner,
    name,
    fixtureImage: image,
    kind: "real-TLS-packaged-proxy-component",
    nativeSubstrateProof: false,
    nativeProductAcceptance: false,
    passed: false,
  };
  let cancelled = false;
  let interruptCommand: (() => void) | undefined;
  const interrupt = () => {
    cancelled = true;
    interruptCommand?.();
  };
  async function command(
    args: string[],
    options: { cleanup?: boolean; allowFailure?: boolean; timeoutMS?: number } = {},
  ) {
    if (cancelled && !options.cleanup) throw Error("Proxy component proof interrupted");
    const child = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      timeout: options.timeoutMS ?? 10_000,
      killSignal: "SIGKILL",
    });
    if (!options.cleanup) interruptCommand = () => child.kill("SIGTERM");
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (!options.allowFailure && exitCode !== 0)
        throw Error(`${args[0]} ${args[1]} failed (${exitCode}): ${stderr.slice(-2000)}`);
      return { exitCode, stdout, stderr };
    } finally {
      if (!options.cleanup) interruptCommand = undefined;
    }
  }
  const receipt = () =>
    writeFile(resolve(directory, "result.json"), `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
  async function input(path: string) {
    const bytes = await readFile(resolve(path));
    return { path, bytes, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
  }
  const keyFiles = ["tls.key", "wrong-ca.key"].map((file) => resolve(directory, file));
  const errors: unknown[] = [];
  let createAttempted = false;
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    record["sourceCommit"] = (await command(["git", "rev-parse", "HEAD"])).stdout.trim();
    const [configuration, fixture, source] = await Promise.all([
      input("deploy/substrate/rootless/tinyproxy.conf"),
      input("test/fixtures/rootless-proxy.py"),
      input("test/integration/substrate-rootless-proxy.native.test.ts"),
    ]);
    record["sourceInputsSHA256"] = Object.fromEntries(
      [configuration, fixture, source].map(({ path, sha256 }) => [path, sha256]),
    );
    await receipt();
    // Inspect never pulls. Docker's create below also refuses an absent cache entry.
    const [cached] = JSON.parse((await command(["docker", "image", "inspect", image])).stdout);
    expect(cached.Id).toMatch(/^sha256:[a-f0-9]{64}$/);
    record["imageID"] = cached.Id;
    record["imagePlatform"] = `${cached.Os}/${cached.Architecture}`;
    record["dockerContext"] = (await command(["docker", "context", "show"])).stdout.trim();
    await writeFile(resolve(directory, "production.conf"), configuration.bytes, { mode: 0o600 });
    await writeFile(resolve(directory, "rootless-proxy.py"), fixture.bytes, { mode: 0o600 });
    for (const prefix of ["tls", "wrong-ca"]) {
      await command([
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=owned-proxy-fixture",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        resolve(directory, `${prefix}.key`),
        "-out",
        resolve(directory, `${prefix}.crt`),
      ]);
    }
    const create = [
      "docker",
      "create",
      "--pull=never",
      "--name",
      name,
      "--cidfile",
      resolve(directory, "container.cid"),
      "--label",
      `${label}=${owner}`,
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user",
      "0:0",
      "--cpus=1",
      "--memory=256m",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/run",
      "--mount",
      `type=bind,source=${directory},target=/fixture,readonly`,
      "--entrypoint",
      "python3",
      image,
      "/fixture/rootless-proxy.py",
    ];
    record["createCommand"] = create;
    record["stage"] = "intended";
    await receipt();
    createAttempted = true;
    const containerID = (await command(create)).stdout.trim();
    expect(containerID).toMatch(/^[a-f0-9]{64}$/);
    expect((await readFile(resolve(directory, "container.cid"), "utf8")).trim()).toBe(containerID);
    record["containerID"] = containerID;
    record["stage"] = "created";
    await receipt();
    const result = await command(["docker", "start", "--attach", containerID], {
      timeoutMS: 65_000,
      allowFailure: true,
    });
    await writeFile(resolve(directory, "process.log"), result.stdout + result.stderr, {
      mode: 0o600,
    });
    record["stage"] = "replied";
    record["exit"] = result.exitCode;
    const proof = JSON.parse(result.stdout.trim());
    record["proof"] = proof;
    expect(result.exitCode, result.stderr).toBe(0);
    expect(proof).toMatchObject({
      passed: true,
      proxyVersion: "tinyproxy 1.11.2",
      quietResponseSeconds: 35,
      tlsValidationDisabled: false,
      trustedControlPassed: true,
      wrongCARefused: true,
      wrongHostRefused: true,
      status: 200,
      bodyMatched: true,
      proxyAndServerJoined: true,
      productionConfigurationSHA256: configuration.sha256,
    });
    expect(proof.elapsedSeconds).toBeGreaterThanOrEqual(35);
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      if (createAttempted) {
        const found = await command(["docker", "container", "inspect", name], {
          cleanup: true,
          allowFailure: true,
        });
        if (found.exitCode === 0) {
          const [current] = JSON.parse(found.stdout);
          const original = (await readFile(resolve(directory, "container.cid"), "utf8")).trim();
          expect(original).toMatch(/^[a-f0-9]{64}$/);
          expect(current.Id).toBe(original);
          expect(current.Config.Labels[label]).toBe(owner);
          record["cleanupIdentity"] = { containerID: original, owner };
          await receipt();
          if (current.State.Running)
            await command(["docker", "stop", "--time", "3", original], { cleanup: true });
          await command(["docker", "rm", original], { cleanup: true });
          const absent = await command(["docker", "container", "inspect", original], {
            cleanup: true,
            allowFailure: true,
          });
          expect(absent.exitCode).not.toBe(0);
          expect(absent.stderr).toMatch(/no such (object|container)/i);
        } else {
          expect(found.stderr).toMatch(/no such (object|container)/i);
          expect(await Bun.file(resolve(directory, "container.cid")).exists()).toBe(false);
        }
      }
      record["containerRemoved"] = true;
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        for (const key of keyFiles) {
          await rm(key, { force: true });
          expect(await Bun.file(key).exists()).toBe(false);
        }
        record["fixturePrivateKeysRemoved"] = true;
      } catch (error) {
        errors.push(error);
      }
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      if (cancelled) errors.push(Error("Proxy component proof interrupted"));
      record["cancelled"] = cancelled;
      record["passed"] = errors.length === 0;
      record["errors"] = errors.map(String);
      await receipt();
    }
  }
  console.log(`Proxy component receipt: ${resolve(directory, "result.json")}`);
  if (errors.length) throw new AggregateError(errors, "Rootless proxy component proof failed");
}, 120_000);
