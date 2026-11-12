import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { eventually } from "./factory-process";

const image = "rancher/k3s@sha256:88d3fac10eb4a429d3c5275f4868fe4b13620f6bbca5bdb5dca0627ac76ae2a0";
const label = "factory.owned-verification-pool";

/** The disposable Docker/k3s topology qualified by the earlier admission receipt. */
export async function verificationPoolCluster(id: string, evidence: string) {
  if (!/^verification-native-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid owned cluster ID");
  const privateDirectory = resolve("/tmp/opencode", id);
  await mkdir(privateDirectory, { mode: 0o700 });
  const containers: Array<{ id: string; name: string; volumes: string[] }> = [];
  const commands: Array<{ args: string[]; exitCode: number }> = [];
  async function command(args: string[], input?: string, sensitive = false) {
    const result = await runCommand(args, input, {
      timeoutMS: 180_000,
      outputBytes: 4 * 1024 ** 2,
    });
    if (!sensitive) commands.push({ args, exitCode: result.exitCode });
    await writeFile(resolve(evidence, "cluster-commands.json"), JSON.stringify(commands, null, 2));
    if (result.exitCode)
      throw new Error(
        `Owned cluster ${args[0]} ${args[1]} failed: ${sensitive ? "private output suppressed" : result.stderr}`,
      );
    return result.stdout.trim();
  }
  const subnet = `10.250.${Number.parseInt(id.slice(-2), 16)}.0/24`;
  const networkID = await command([
    "docker",
    "network",
    "create",
    "--subnet",
    subnet,
    "--label",
    `${label}=${id}`,
    id,
  ]);
  const metadata = JSON.parse(await command(["docker", "network", "inspect", id]))[0];
  const gateway: string = metadata.IPAM.Config[0].Gateway;
  const nodeA = `${id}-a`;
  const nodeB = `${id}-b`;
  const kubeconfig = resolve(privateDirectory, "kubeconfig");
  async function saveOwnership() {
    await writeFile(
      resolve(evidence, "cluster-ownership.json"),
      JSON.stringify({ id, networkID, gateway, subnet, containers }, null, 2),
    );
  }
  async function node(name: string, args: string[]) {
    const containerID = await command([
      "docker",
      "run",
      "-d",
      "--name",
      name,
      "--hostname",
      name,
      "--label",
      `${label}=${id}`,
      "--network",
      id,
      "--dns",
      "1.1.1.1",
      "--privileged",
      "--cgroupns=private",
      "--cpus=4",
      "--memory=4g",
      "--memory-swap=4g",
      "--pids-limit=8192",
      "--tmpfs",
      "/run",
      "--tmpfs",
      "/var/run",
      "--mount",
      `type=bind,src=${privateDirectory},dst=/owned,readonly`,
      ...(name === nodeA ? ["--publish", "127.0.0.1::6443"] : []),
      image,
      ...args,
      "--node-name",
      name,
      "--kubelet-arg",
      "cgroup-driver=cgroupfs",
      "--kubelet-arg",
      "system-reserved=cpu=12,memory=11Gi",
    ]);
    const info = JSON.parse(await command(["docker", "inspect", containerID]))[0];
    if (info.Config.Labels[label] !== id || info.Id !== containerID)
      throw new Error("Node ownership differs");
    containers.push({
      id: containerID,
      name,
      volumes: info.Mounts.filter((mount: { Type: string }) => mount.Type === "volume").map(
        (mount: { Name: string }) => mount.Name,
      ),
    });
    await saveOwnership();
  }
  async function kubectl(args: string[]) {
    return command(["kubectl", "--kubeconfig", kubeconfig, ...args]);
  }
  return {
    id,
    gateway,
    nodeA,
    nodeB,
    kubeconfig,
    privateDirectory,
    command,
    kubectl,
    async stopNodeB() {
      const original = containers.find((container) => container.name === nodeB);
      if (!original) throw new Error("Owned node B has no create receipt");
      const info = JSON.parse(await command(["docker", "inspect", original.id]))[0];
      if (info.Id !== original.id || info.Config.Labels[label] !== id || info.Name !== `/${nodeB}`)
        throw new Error("Owned node B loss injection refused");
      await command(["docker", "stop", "--time", "30", original.id]);
    },
    async start(registryHost: string, certificate: string) {
      await writeFile(resolve(privateDirectory, "registry-ca.pem"), certificate, { mode: 0o600 });
      await writeFile(
        resolve(privateDirectory, "registries.yaml"),
        `configs:\n  "${registryHost}":\n    tls:\n      ca_file: /owned/registry-ca.pem\n`,
        { mode: 0o600 },
      );
      await node(nodeA, [
        "server",
        "--disable",
        "traefik",
        "--disable",
        "servicelb",
        "--disable",
        "metrics-server",
        "--private-registry",
        "/owned/registries.yaml",
      ]);
      await eventually(
        () =>
          command(
            ["docker", "exec", nodeA, "cat", "/etc/rancher/k3s/k3s.yaml"],
            undefined,
            true,
          ).catch(() => ""),
        Boolean,
        "Owned API kubeconfig missing",
        90_000,
      );
      const config = await command(
        ["docker", "exec", nodeA, "cat", "/etc/rancher/k3s/k3s.yaml"],
        undefined,
        true,
      );
      const port = (await command(["docker", "port", nodeA, "6443/tcp"])).split(":").at(-1);
      await writeFile(kubeconfig, config.replace("127.0.0.1:6443", `127.0.0.1:${port}`), {
        mode: 0o600,
      });
      await writeFile(
        resolve(privateDirectory, "cluster-token"),
        await command(
          ["docker", "exec", nodeA, "cat", "/var/lib/rancher/k3s/server/node-token"],
          undefined,
          true,
        ),
        { mode: 0o600 },
      );
      await node(nodeB, [
        "agent",
        "--server",
        `https://${nodeA}:6443`,
        "--token-file",
        "/owned/cluster-token",
        "--private-registry",
        "/owned/registries.yaml",
      ]);
      await eventually(
        async () => JSON.parse(await kubectl(["get", "nodes", "-o", "json"])).items,
        (nodes: Array<{ metadata: { name: string } }>) =>
          [nodeA, nodeB].every((name) => nodes.some((node) => node.metadata.name === name)),
        "Owned nodes did not register",
        180_000,
      );
      await kubectl([
        "wait",
        "--for=condition=Ready",
        `node/${nodeA}`,
        `node/${nodeB}`,
        "--timeout=180s",
      ]);
      for (const deployment of ["coredns", "local-path-provisioner"]) {
        await kubectl([
          "-n",
          "kube-system",
          "rollout",
          "status",
          `deployment/${deployment}`,
          "--timeout=180s",
        ]);
      }
      const nodes = JSON.parse(await kubectl(["get", "nodes", "-o", "json"]));
      await writeFile(resolve(evidence, "nodes-before.json"), JSON.stringify(nodes, null, 2));
      return nodes;
    },
    async dispose() {
      for (const container of containers.toReversed()) {
        await writeFile(
          resolve(evidence, `${container.name}.log`),
          await command(["docker", "logs", container.id]).catch(
            () => "Owned node logs unavailable",
          ),
        );
        const info = JSON.parse(await command(["docker", "inspect", container.id]))[0];
        if (
          info.Id !== container.id ||
          info.Name !== `/${container.name}` ||
          info.Config.Labels[label] !== id
        )
          throw new Error("Exact node cleanup ownership differs");
        await command(["docker", "rm", "--force", container.id]);
        for (const volume of container.volumes) await command(["docker", "volume", "rm", volume]);
      }
      const network = JSON.parse(await command(["docker", "network", "inspect", networkID]))[0];
      if (
        network.Id !== networkID ||
        network.Labels[label] !== id ||
        Object.keys(network.Containers).length
      )
        throw new Error("Exact network cleanup refused");
      await command(["docker", "network", "rm", networkID]);
      if ((await readFile(resolve(evidence, "cluster-ownership.json"), "utf8")).includes(networkID))
        await rm(privateDirectory, { recursive: true });
      await writeFile(
        resolve(evidence, "cluster-cleanup.json"),
        JSON.stringify({ id, networkID, containers, removed: true }, null, 2),
      );
    },
  };
}
