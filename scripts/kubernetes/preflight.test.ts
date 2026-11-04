import { expect, test } from "bun:test";
import { configuredFactoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import {
  formatPreflight,
  type Kubectl,
  placeholderWorkerImage,
  preflightExitCode,
  preflightOptionsFromArguments,
  runPreflight,
} from "./preflight";
import {
  evaluateAdmission,
  evaluateNode,
  evaluateNodeFacts,
  evaluateReleaseNamespace,
  evaluateStorage,
  kernelConfigRequirements,
  type NodeFacts,
  nodeProbeProgram,
  parseNodeFacts,
} from "./preflight-checks";

const image = `registry.invalid/factorybox@sha256:${"a".repeat(64)}`;
const profile = configuredFactoryboxRuntimeProfile({
  FACTORY_FACTORYBOX_WORKER_IMAGE: image,
  FACTORY_FACTORYBOX_EXECUTABLE_SHA256: "b".repeat(64),
  FACTORY_FACTORYBOX_ARCHITECTURE: "amd64",
  FACTORY_FACTORYBOX_NODE: "aks-workers-12345678-vmss000000",
  FACTORY_FACTORYBOX_KERNEL: "5.15.0-*-azure,6.8.0-*-azure",
  FACTORY_FACTORYBOX_MEMORY_HEADROOM_MIB: "2048",
});

function node(overrides: Record<string, unknown> = {}) {
  return {
    metadata: {
      name: profile.nodeName,
      uid: "node-uid",
      labels: { "kubernetes.io/hostname": profile.nodeName },
    },
    spec: {},
    status: {
      nodeInfo: {
        architecture: "amd64",
        operatingSystem: "linux",
        kernelVersion: "5.15.0-1068-azure",
        osImage: "Ubuntu 22.04.4 LTS",
        containerRuntimeVersion: "containerd://1.7.15-1",
      },
      allocatable: { cpu: "3860m", memory: "12582912Ki", "ephemeral-storage": "119703055367" },
      conditions: [{ type: "Ready", status: "True" }],
    },
    ...overrides,
  };
}
const status = (checks: Array<{ id: string; status: string }>, id: string) =>
  checks.find((check) => check.id === id)?.status;

test("an AKS Ubuntu node passes and an upgraded kernel stays inside the policy", () => {
  const checks = evaluateNode(profile, node());
  expect(checks.filter((check) => check.status === "FAIL")).toEqual([]);
  expect(status(checks, "node.kernel-policy")).toBe("PASS");
  const upgraded = node();
  upgraded.status.nodeInfo.kernelVersion = "6.8.0-1015-azure";
  expect(status(evaluateNode(profile, upgraded), "node.kernel-policy")).toBe("PASS");
});

test("without a kernel restriction any release passes the policy check and only the node minimum applies", () => {
  const open = configuredFactoryboxRuntimeProfile({
    FACTORY_FACTORYBOX_WORKER_IMAGE: image,
    FACTORY_FACTORYBOX_EXECUTABLE_SHA256: "b".repeat(64),
    FACTORY_FACTORYBOX_ARCHITECTURE: "amd64",
    FACTORY_FACTORYBOX_NODE: profile.nodeName,
  });
  expect(open.kernel).toBeUndefined();
  const custom = node();
  custom.status.nodeInfo.kernelVersion = "6.12.4-custom";
  const checks = evaluateNode(open, custom);
  expect(status(checks, "node.kernel-policy")).toBe("PASS");
  expect(checks.find((check) => check.id === "node.kernel-policy")?.message).toContain(
    "capability gate",
  );
  custom.status.nodeInfo.kernelVersion = "5.4.0-1-azure";
  expect(status(evaluateNode(open, custom), "node.kernel-minimum")).toBe("FAIL");
});

test.each([
  [
    "architecture",
    (value: ReturnType<typeof node>) => (value.status.nodeInfo.architecture = "arm64"),
    "node.platform",
  ],
  [
    "kernel",
    (value: ReturnType<typeof node>) => (value.status.nodeInfo.kernelVersion = "5.15.0-1-generic"),
    "node.kernel-policy",
  ],
  [
    "old kernel",
    (value: ReturnType<typeof node>) => (value.status.nodeInfo.kernelVersion = "5.4.0-1-azure"),
    "node.kernel-minimum",
  ],
  [
    "hostname label",
    (value: ReturnType<typeof node>) => (value.metadata.labels["kubernetes.io/hostname"] = "other"),
    "node.hostname",
  ],
  [
    "not ready",
    (value: ReturnType<typeof node>) =>
      (value.status.conditions = [{ type: "Ready", status: "False" }]),
    "node.ready",
  ],
])("a node with a wrong %s is refused with a fix", (_name, mutate, id) => {
  const value = node();
  mutate(value);
  const check = evaluateNode(profile, value).find((item) => item.id === id);
  expect(check?.status).toBe("FAIL");
  expect(check?.fix).toBeTruthy();
});

test("taints that the worker Pod cannot tolerate are refused, automatic ones are not", () => {
  const tainted = node({
    spec: {
      taints: [
        { key: "kubernetes.azure.com/scalesetpriority", effect: "NoSchedule", value: "spot" },
        { key: "node.kubernetes.io/unreachable", effect: "NoExecute" },
      ],
    },
  });
  const check = evaluateNode(profile, tainted).find((item) => item.id === "node.taints");
  expect(check?.status).toBe("FAIL");
  expect(check?.message).toContain("scalesetpriority");
  expect(check?.message).not.toContain("unreachable");
});

test("storage accepts Azure Disk, refuses file shares and flags immediate zonal binding", () => {
  const classes = (items: unknown[]) => ({ items });
  const azure = (extra: Record<string, unknown> = {}) => ({
    metadata: {
      name: "managed-csi",
      annotations: { "storageclass.kubernetes.io/is-default-class": "true" },
    },
    provisioner: "disk.csi.azure.com",
    volumeBindingMode: "WaitForFirstConsumer",
    parameters: { skuName: "StandardSSD_LRS" },
    ...extra,
  });
  const csi = { spec: { drivers: [{ name: "disk.csi.azure.com", allocatable: { count: 8 } }] } };
  expect(
    evaluateStorage(undefined, classes([azure()]), csi).every((c) => c.status === "PASS"),
  ).toBe(true);
  const immediate = evaluateStorage(
    undefined,
    classes([azure({ volumeBindingMode: "Immediate" })]),
    csi,
  );
  expect(status(immediate, "storage.binding")).toBe("WARN");
  const hdd = evaluateStorage(
    undefined,
    classes([azure({ parameters: { skuName: "Standard_LRS" } })]),
    csi,
  );
  expect(status(hdd, "storage.sku")).toBe("WARN");
  const files = evaluateStorage(
    "azurefile-csi",
    classes([{ metadata: { name: "azurefile-csi" }, provisioner: "file.csi.azure.com" }]),
    undefined,
  );
  expect(status(files, "storage.provisioner")).toBe("FAIL");
  expect(status(evaluateStorage(undefined, classes([]), undefined), "storage.class")).toBe("FAIL");
  const small = evaluateStorage(undefined, classes([azure()]), {
    spec: { drivers: [{ name: "disk.csi.azure.com", allocatable: { count: 2 } }] },
  });
  expect(status(small, "storage.attach-limit")).toBe("WARN");
  expect(
    status(
      evaluateStorage(undefined, classes([azure()]), { spec: { drivers: [] } }),
      "storage.csi-node",
    ),
  ).toBe("FAIL");
});

test("a restricted release Namespace is refused because Factory runs as root", () => {
  const namespace = (level?: string) => ({
    metadata: { labels: level ? { "pod-security.kubernetes.io/enforce": level } : {} },
  });
  expect(evaluateReleaseNamespace(namespace("restricted")).status).toBe("FAIL");
  expect(evaluateReleaseNamespace(namespace("baseline")).status).toBe("PASS");
  expect(evaluateReleaseNamespace(namespace()).status).toBe("PASS");
});

test("admission refusals name the denying layer and its fix", () => {
  const psa = evaluateAdmission(
    "admission.worker-pod",
    "The privileged worker Pod",
    {
      exitCode: 1,
      stderr:
        'Error from server (Forbidden): pods "worker" is forbidden: violates PodSecurity "baseline:latest": privileged',
    },
    false,
  );
  expect(psa.status).toBe("FAIL");
  expect(psa.message).toContain("Pod Security Admission");
  const policy = evaluateAdmission(
    "x",
    "Pod",
    { exitCode: 1, stderr: 'admission webhook "validation.gatekeeper.sh" denied the request' },
    true,
  );
  expect(policy.message).toContain("policy engine");
  expect(evaluateAdmission("x", "Pod", { exitCode: 0, stderr: "" }, false).status).toBe("PASS");
});

function facts(overrides: Partial<NodeFacts> = {}): NodeFacts {
  return {
    release: "5.15.0-1068-azure",
    machine: "x86_64",
    pageSize: 4096,
    cgroupFilesystem: "cgroup2",
    cgroupControllers: "cpuset cpu io memory hugetlb pids rdma misc",
    config: {
      source: "/host/boot/config-5.15.0-1068-azure",
      values: Object.fromEntries(kernelConfigRequirements.map((item) => [item.option, "y"])),
    },
    filesystems: ["overlay", "fuse", "ext4"],
    btf: true,
    userfaultfd: { available: true, errno: 0 },
    unprivilegedUserfaultfd: "0",
    nsLastPidWritable: true,
    maxUserNamespaces: 63359,
    devices: { "loop-control": true, fuse: true },
    doctor: { exitCode: 0, stdout: '{"matches_reference":true}' },
    ...overrides,
  };
}

test("complete node facts pass every kernel check", () => {
  const checks = evaluateNodeFacts(facts());
  expect(checks.filter((check) => check.status !== "PASS")).toEqual([]);
});

test("missing kernel facilities fail or warn with exact remediation", () => {
  const values = {
    ...facts().config.values,
    CONFIG_CHECKPOINT_RESTORE: "n",
    CONFIG_USERFAULTFD: "n",
  };
  delete (values as Record<string, string>)["CONFIG_FUSE_FS"];
  const checks = evaluateNodeFacts(
    facts({
      cgroupFilesystem: "tmpfs",
      btf: false,
      config: { source: "/proc/config.gz", values },
      userfaultfd: { available: false, errno: 38 },
      doctor: { exitCode: 1, stdout: "unsupported execution platform: kernel=5.15.0-1068-azure" },
    }),
  );
  expect(status(checks, "kernel.cgroup-v2")).toBe("FAIL");
  expect(status(checks, "kernel.checkpoint_restore")).toBe("FAIL");
  expect(status(checks, "kernel.fuse_fs")).toBe("FAIL");
  expect(status(checks, "kernel.userfaultfd")).toBe("WARN");
  expect(status(checks, "kernel.btf")).toBe("FAIL");
  const doctor = checks.find((check) => check.id === "worker.doctor");
  expect(doctor?.status).toBe("FAIL");
  expect(doctor?.fix).toContain("5.15.0-1068-azure");
});

test("a node the worker accepts on an unverified kernel is a warning, not a failure", () => {
  for (const stdout of [
    '{"platform":{"kernel":"5.15.0-1068-azure"},"qualification":"unverified"}',
    "kernel=5.15.0-1068-azure qualification=unverified",
  ]) {
    const checks = evaluateNodeFacts(facts({ doctor: { exitCode: 0, stdout } }));
    expect(status(checks, "worker.doctor")).toBe("WARN");
    expect(checks.some((check) => check.status === "FAIL")).toBe(false);
  }
  const verified = evaluateNodeFacts(
    facts({ doctor: { exitCode: 0, stdout: '{"qualification":"verified"}' } }),
  );
  expect(status(verified, "worker.doctor")).toBe("PASS");
});

test("an unreadable kernel configuration falls back to loaded filesystems with warnings", () => {
  const checks = evaluateNodeFacts(
    facts({ config: { source: null, values: {} }, filesystems: ["ext4"] }),
  );
  expect(status(checks, "kernel.config")).toBe("WARN");
  expect(status(checks, "kernel.overlay_fs")).toBe("WARN");
  expect(status(checks, "kernel.fuse_fs")).toBe("WARN");
  expect(checks.some((check) => check.status === "FAIL")).toBe(false);
});

test("the node probe program is valid Python carrying every checked option", async () => {
  const program = nodeProbeProgram();
  for (const item of kernelConfigRequirements) expect(program).toContain(item.option);
  const child = Bun.spawn(
    ["python3", "-c", "import sys; compile(sys.stdin.read(), 'probe', 'exec')"],
    { stdin: new TextEncoder().encode(program), stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(0);
  expect(parseNodeFacts(`noise\nFACTORY_PREFLIGHT ${JSON.stringify(facts())}\n`)?.release).toBe(
    "5.15.0-1068-azure",
  );
  expect(parseNodeFacts("no facts")).toBeNull();
  expect(parseNodeFacts("FACTORY_PREFLIGHT {broken")).toBeNull();
});

function cluster(options: { denyPod?: boolean; denyAlways?: boolean } = {}) {
  const calls: string[][] = [];
  const created: string[] = [];
  const run: Kubectl = async (args, input) => {
    calls.push([...args]);
    const [verb, kind, name] = args;
    const ok = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
    if (verb === "get" && kind === "node") return ok(node());
    if (verb === "get" && kind === "pods") return ok({ items: [] });
    if (verb === "get" && kind === "storageclass")
      return ok({
        items: [
          {
            metadata: {
              name: "managed-csi",
              annotations: { "storageclass.kubernetes.io/is-default-class": "true" },
            },
            provisioner: "disk.csi.azure.com",
            volumeBindingMode: "WaitForFirstConsumer",
          },
        ],
      });
    if (verb === "get" && kind === "csinode")
      return ok({ spec: { drivers: [{ name: "disk.csi.azure.com", allocatable: { count: 8 } }] } });
    if (verb === "get" && kind === "namespace" && name === "factory")
      return ok({ metadata: { labels: {} } });
    if (verb === "get" && kind === "namespace")
      return ok({ metadata: { labels: { "factory.dev/preflight": created[0]?.split("-")[2] } } });
    if (verb === "get" && kind === "pod") return ok({ status: { phase: "Succeeded" } });
    if (verb === "logs")
      return { exitCode: 0, stdout: `FACTORY_PREFLIGHT ${JSON.stringify(facts())}\n`, stderr: "" };
    if (verb === "create" && args.includes("--dry-run=server")) {
      const resource = JSON.parse(input ?? "{}") as {
        kind: string;
        metadata: { namespace: string };
      };
      const privileged = resource.metadata.namespace.endsWith("-privileged");
      if (resource.kind === "Pod" && (options.denyAlways || (options.denyPod && !privileged)))
        return {
          exitCode: 1,
          stdout: "",
          stderr: 'violates PodSecurity "baseline:latest": privileged',
        };
      return ok({});
    }
    if (verb === "create") {
      const resource = JSON.parse(input ?? "{}") as { kind: string; metadata: { name: string } };
      if (resource.kind === "Namespace") created.push(resource.metadata.name);
      return ok(resource);
    }
    return ok({});
  };
  return { run, calls, created };
}

const options = { profile, releaseNamespace: "factory", readOnly: false, probeTimeoutMS: 1000 };

test("a healthy AKS-like cluster passes and only the throwaway Namespace is created and deleted", async () => {
  const fake = cluster();
  const checks = await runPreflight(options, fake.run, async () => {});
  expect(checks.filter((check) => check.status === "FAIL")).toEqual([]);
  expect(preflightExitCode(checks)).toBe(0);
  expect(status(checks, "admission.worker-pod")).toBe("PASS");
  expect(status(checks, "kernel.checkpoint_restore")).toBe("PASS");
  expect(fake.created).toHaveLength(1);
  const deleted = fake.calls.filter((args) => args[0] === "delete");
  expect(deleted).toEqual([["delete", "namespace", fake.created[0] as string, "--wait=false"]]);
  const creates = fake.calls.filter(
    (args) => args[0] === "create" && !args.includes("--dry-run=server"),
  );
  expect(creates).toHaveLength(2);
  expect(formatPreflight(checks)).toContain("0 failed");
});

test("read-only mode creates nothing and says what it skipped", async () => {
  const fake = cluster();
  const checks = await runPreflight({ ...options, readOnly: true }, fake.run, async () => {});
  expect(fake.calls.every((args) => args[0] === "get")).toBe(true);
  expect(status(checks, "admission.worker-pod")).toBe("SKIP");
});

test("a Pod Security default is told apart from a policy engine", async () => {
  const labelled = await runPreflight(options, cluster({ denyPod: true }).run, async () => {});
  expect(status(labelled, "admission.worker-pod")).toBe("FAIL");
  expect(status(labelled, "admission.privileged-label")).toBe("PASS");
  expect(status(labelled, "kernel.btf")).toBe("PASS");
  expect(preflightExitCode(labelled)).toBe(1);
  const engine = await runPreflight(options, cluster({ denyAlways: true }).run, async () => {});
  expect(status(engine, "admission.privileged-label")).toBe("FAIL");
  expect(status(engine, "node.probe")).toBe("SKIP");
  const fake = cluster({ denyAlways: true });
  await runPreflight(options, fake.run, async () => {});
  expect(fake.calls.filter((args) => args[0] === "delete")).toHaveLength(2);
});

test("options come from flags over the installation environment", () => {
  const parsed = preflightOptionsFromArguments(
    ["--node", "n1", "--kernel", "6.8.*", "--read-only", "--json"],
    {
      FACTORY_FACTORYBOX_ARCHITECTURE: "amd64",
      FACTORY_FACTORYBOX_NODE: "other",
      FACTORY_FACTORYBOX_KERNEL: "5.15.*",
      FACTORY_STORAGE_CLASS: "managed-csi",
      FACTORY_PREFLIGHT_NAMESPACE: "factory",
    },
  );
  expect(parsed.profile.nodeName).toBe("n1");
  expect(parsed.profile.kernel).toBe("6.8.*");
  expect(parsed.profile.image).toBe(placeholderWorkerImage);
  expect(parsed.storageClass).toBe("managed-csi");
  expect(parsed.releaseNamespace).toBe("factory");
  expect(parsed.readOnly && parsed.json).toBe(true);
});
