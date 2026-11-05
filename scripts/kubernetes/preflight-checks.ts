// Pure evaluation of a node and cluster against the Factorybox worker's requirements.
// Every check names what it verified and the exact remediation. These are pre-screens
// derived from the worker's Pod declaration, the standalone runtime's source and the
// upstream Sysbox/CRIU requirements. They do not qualify a node. The pinned worker's own
// `factorybox doctor` and startup checks stay authoritative.
import { z } from "zod";
import {
  factoryboxKernelMatches,
  factoryboxKernelRestriction,
} from "../../packages/runtime-kubernetes/src/factorybox-kernel";
import { selectFactoryboxWorkerResources } from "../../packages/runtime-kubernetes/src/factorybox-resource-admission";
import type { FactoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";

export type PreflightStatus = "PASS" | "FAIL" | "WARN" | "SKIP";
export interface PreflightCheck {
  readonly id: string;
  readonly status: PreflightStatus;
  readonly message: string;
  readonly fix?: string;
}

const pass = (id: string, message: string): PreflightCheck => ({ id, status: "PASS", message });
const fail = (id: string, message: string, fix: string): PreflightCheck => ({
  id,
  status: "FAIL",
  message,
  fix,
});
const warn = (id: string, message: string, fix: string): PreflightCheck => ({
  id,
  status: "WARN",
  message,
  fix,
});
export const skip = (id: string, message: string, fix?: string): PreflightCheck => ({
  id,
  status: "SKIP",
  message,
  ...(fix ? { fix } : {}),
});

const taint = z.object({ key: z.string(), effect: z.string(), value: z.string().optional() });
const nodeShape = z.object({
  metadata: z.object({
    name: z.string(),
    labels: z.record(z.string(), z.string()).optional(),
  }),
  spec: z
    .object({ unschedulable: z.boolean().optional(), taints: z.array(taint).optional() })
    .optional(),
  status: z.object({
    nodeInfo: z.object({
      architecture: z.string(),
      kernelVersion: z.string(),
      operatingSystem: z.string(),
      osImage: z.string().optional(),
      containerRuntimeVersion: z.string().optional(),
      kubeletVersion: z.string().optional(),
    }),
    allocatable: z.record(z.string(), z.string()).optional(),
    conditions: z.array(z.object({ type: z.string(), status: z.string() })).optional(),
  }),
});

// Kubernetes adds these tolerations to every Pod; the worker Pod declares none of its own.
const automaticallyTolerated = /^node\.kubernetes\.io\/(?:not-ready|unreachable)$/;

export function parseKernelRelease(release: string) {
  const match = /^(\d+)\.(\d+)/.exec(release);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

export function evaluateNode(profile: FactoryboxRuntimeProfile, nodeInput: unknown) {
  const parsed = nodeShape.safeParse(nodeInput);
  if (!parsed.success)
    return [
      fail(
        "node.exists",
        `Node ${profile.nodeName} was not readable`,
        `Set factorybox.nodeName to an existing node: kubectl get nodes -o name`,
      ),
    ];
  const node = parsed.data;
  const info = node.status.nodeInfo;
  const checks: PreflightCheck[] = [];
  const ready = node.status.conditions?.some((c) => c.type === "Ready" && c.status === "True");
  checks.push(
    ready && !node.spec?.unschedulable
      ? pass("node.ready", `${node.metadata.name} is Ready and schedulable`)
      : fail(
          "node.ready",
          `${node.metadata.name} is not Ready or is cordoned`,
          `kubectl uncordon ${node.metadata.name}; wait for Ready before installing`,
        ),
  );
  checks.push(
    node.metadata.labels?.["kubernetes.io/hostname"] === profile.nodeName
      ? pass("node.hostname", "kubernetes.io/hostname label equals the node name")
      : fail(
          "node.hostname",
          `kubernetes.io/hostname is ${node.metadata.labels?.["kubernetes.io/hostname"] ?? "missing"}, not ${profile.nodeName}. The worker Pod selects its node by that label.`,
          `Set factorybox.nodeName to the label value: kubectl get node ${profile.nodeName} -L kubernetes.io/hostname`,
        ),
  );
  checks.push(
    info.operatingSystem === "linux" && info.architecture === profile.architecture
      ? pass("node.platform", `linux/${info.architecture}`)
      : fail(
          "node.platform",
          `Node is ${info.operatingSystem}/${info.architecture}; factorybox.architecture is ${profile.architecture}`,
          `Use a linux/${profile.architecture} node pool or set factorybox.architecture to the node's architecture and a matching worker image`,
        ),
  );
  const restriction = factoryboxKernelRestriction(profile.kernel);
  checks.push(
    !restriction
      ? pass(
          "node.kernel-policy",
          `Kernel ${info.kernelVersion}. factorybox.kernel does not restrict kernels, so the worker's capability gate decides`,
        )
      : factoryboxKernelMatches(restriction, info.kernelVersion)
        ? pass("node.kernel-policy", `Kernel ${info.kernelVersion} matches factorybox.kernel`)
        : fail(
            "node.kernel-policy",
            `Kernel ${info.kernelVersion} is outside factorybox.kernel ${restriction}`,
            `Widen factorybox.kernel to a pattern such as ${info.kernelVersion.replace(/\d+(?=-)/, "*")}, or leave it empty to let the worker's capability gate decide`,
          ),
  );
  const version = parseKernelRelease(info.kernelVersion);
  checks.push(
    version && (version.major > 5 || (version.major === 5 && version.minor >= 15))
      ? pass("node.kernel-minimum", "Kernel is 5.15 or newer (BPF task helpers, ID-mapped mounts)")
      : fail(
          "node.kernel-minimum",
          `Kernel ${info.kernelVersion} is older than 5.15`,
          "Use a node image with kernel 5.15 or newer (for example Ubuntu 22.04)",
        ),
  );
  checks.push(
    /ubuntu/i.test(info.osImage ?? "")
      ? pass("node.os-image", info.osImage ?? "")
      : warn(
          "node.os-image",
          `Node OS image is ${info.osImage ?? "unknown"}. Only Ubuntu nodes are expected to carry the Sysbox and CRIU facilities.`,
          "Use an Ubuntu node pool (on AKS: --os-sku Ubuntu)",
        ),
  );
  checks.push(
    /^containerd:\/\//.test(info.containerRuntimeVersion ?? "")
      ? pass("node.runtime", info.containerRuntimeVersion ?? "")
      : warn(
          "node.runtime",
          `Container runtime is ${info.containerRuntimeVersion ?? "unknown"}`,
          "Use containerd nodes",
        ),
  );
  const blocking = (node.spec?.taints ?? []).filter(
    (item) =>
      (item.effect === "NoSchedule" || item.effect === "NoExecute") &&
      !automaticallyTolerated.test(item.key),
  );
  checks.push(
    blocking.length
      ? fail(
          "node.taints",
          `Node has taints ${blocking.map((item) => `${item.key}:${item.effect}`).join(", ")}. The worker and Source Pods declare no tolerations.`,
          `Remove the taints from the dedicated node: kubectl taint node ${node.metadata.name} ${blocking.map((item) => `${item.key}-`).join(" ")}. On AKS create the pool without --node-taints.`,
        )
      : pass("node.taints", "No scheduling taint blocks the worker Pod"),
  );
  const ephemeral = node.status.allocatable?.["ephemeral-storage"];
  const ephemeralBytes = ephemeral ? quantityBytes(ephemeral) : undefined;
  if (ephemeralBytes !== undefined && ephemeralBytes < 40 * 1024 ** 3)
    checks.push(
      warn(
        "node.ephemeral-storage",
        `Allocatable ephemeral storage is ${(ephemeralBytes / 1024 ** 3).toFixed(0)} GiB. The worker image and Dev Container layers live on the node's OS disk.`,
        "Use a node pool with an OS disk of at least 128 GiB",
      ),
    );
  return checks;
}

function quantityBytes(value: string) {
  const match = /^(\d+)(Ki|Mi|Gi|Ti)?$/.exec(value);
  if (!match) return undefined;
  const scale = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 } as const;
  return Number(match[1]) * (match[2] ? scale[match[2] as keyof typeof scale] : 1);
}

export function evaluateBudget(
  profile: FactoryboxRuntimeProfile,
  nodeInput: unknown,
  podsInput: unknown,
) {
  try {
    const budget = selectFactoryboxWorkerResources(profile, nodeInput, podsInput);
    const detail = `${budget.cpuMilli}m CPU and ${budget.memoryMiB} MiB memory remain for the worker after other Pods' requests and ${profile.resourceAdmission?.memoryHeadroomMiB ?? 0} MiB headroom`;
    return budget.memoryMiB < 3072 || budget.cpuMilli < 3000
      ? warn(
          "node.budget",
          `${detail}. The qualified fixtures used 3 CPU and 3 GiB.`,
          "Use a larger VM size for the worker pool, or lower factorybox.memoryHeadroomMiB",
        )
      : pass("node.budget", detail);
  } catch (cause) {
    return fail(
      "node.budget",
      cause instanceof Error && !(cause instanceof z.ZodError)
        ? cause.message
        : "The node or Pod list does not have the fields worker admission reads",
      "Use a larger VM size, move other Pods off the node, or lower factorybox.memoryHeadroomMiB",
    );
  }
}

const storageClass = z.object({
  metadata: z.object({
    name: z.string(),
    annotations: z.record(z.string(), z.string()).optional(),
  }),
  provisioner: z.string(),
  volumeBindingMode: z.string().optional(),
  parameters: z.record(z.string(), z.string()).optional(),
  allowedTopologies: z.array(z.unknown()).optional(),
});

const sharedFilesystemProvisioners = [
  "file.csi.azure.com",
  "blob.csi.azure.com",
  "nfs.csi.k8s.io",
  "efs.csi.aws.com",
  "filestore.csi.storage.gke.io",
];
const knownBlockProvisioners: Record<string, string> = {
  "disk.csi.azure.com": "Azure Disk CSI",
  "rancher.io/local-path": "local-path (single node)",
};

export function evaluateStorage(
  requested: string | undefined,
  classesInput: unknown,
  csiNodeInput: unknown,
) {
  const items = z.object({ items: z.array(storageClass) }).safeParse(classesInput).data?.items;
  if (!items)
    return [
      fail(
        "storage.class",
        "StorageClasses were not readable",
        "Grant get/list on storageclasses to the preflight ServiceAccount",
      ),
    ];
  const selected = requested
    ? items.find((item) => item.metadata.name === requested)
    : items.find(
        (item) =>
          item.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true" ||
          item.metadata.annotations?.["storageclass.beta.kubernetes.io/is-default-class"] ===
            "true",
      );
  if (!selected)
    return [
      fail(
        "storage.class",
        requested
          ? `StorageClass ${requested} does not exist`
          : "The cluster has no default StorageClass",
        requested
          ? "kubectl get storageclass; set storageClass to an existing name"
          : "Set storageClass in the Helm values. On AKS use managed-csi or managed-csi-premium.",
      ),
    ];
  const checks: PreflightCheck[] = [];
  const known = knownBlockProvisioners[selected.provisioner];
  if (sharedFilesystemProvisioners.includes(selected.provisioner))
    checks.push(
      fail(
        "storage.provisioner",
        `${selected.metadata.name} uses ${selected.provisioner}, a network file share. The worker's bounded store is a loop-mounted ext4 image with direct I/O and needs block storage.`,
        "Use a ReadWriteOnce block StorageClass. On AKS use managed-csi (Azure Disk).",
      ),
    );
  else if (known)
    checks.push(
      pass(
        "storage.provisioner",
        `${selected.metadata.name} uses ${selected.provisioner} (${known}), a ReadWriteOnce block provisioner`,
      ),
    );
  else
    checks.push(
      warn(
        "storage.provisioner",
        `${selected.metadata.name} uses ${selected.provisioner}. Only Azure Disk and local-path are recognized as block provisioners.`,
        "Confirm it provides ReadWriteOnce block-backed volumes with POSIX semantics and direct I/O",
      ),
    );
  if (selected.provisioner === "disk.csi.azure.com") {
    const sku = selected.parameters?.["skuName"] ?? selected.parameters?.["storageaccounttype"];
    if (sku === "Standard_LRS")
      checks.push(
        warn(
          "storage.sku",
          "Azure Disk SKU Standard_LRS is HDD. Checkpoint and restore of large processes are IOPS bound.",
          "Use managed-csi (StandardSSD_LRS) or managed-csi-premium",
        ),
      );
    if (selected.volumeBindingMode !== "WaitForFirstConsumer")
      checks.push(
        warn(
          "storage.binding",
          `volumeBindingMode is ${selected.volumeBindingMode ?? "Immediate"}. Azure Disks are zonal; the disk can be created in a zone other than the pinned worker node's.`,
          "Use a StorageClass with volumeBindingMode: WaitForFirstConsumer (managed-csi on current AKS)",
        ),
      );
    else checks.push(pass("storage.binding", "volumeBindingMode is WaitForFirstConsumer"));
  }
  const csi = z
    .object({
      spec: z.object({
        drivers: z
          .array(
            z.object({
              name: z.string(),
              allocatable: z.object({ count: z.number().optional() }).optional(),
            }),
          )
          .optional(),
      }),
    })
    .safeParse(csiNodeInput);
  if (csi.success) {
    const driver = csi.data.spec.drivers?.find((item) => item.name === selected.provisioner);
    if (!driver && selected.provisioner !== "rancher.io/local-path")
      checks.push(
        fail(
          "storage.csi-node",
          `CSI driver ${selected.provisioner} is not registered on the worker node`,
          "Check the CSI node DaemonSet runs on the worker node (kubectl get pods -n kube-system -o wide)",
        ),
      );
    else if (driver?.allocatable?.count !== undefined && driver.allocatable.count < 4)
      checks.push(
        warn(
          "storage.attach-limit",
          `The node can attach ${driver.allocatable.count} volumes. The worker store, canonical Source and every Developer IDE claim share this node.`,
          "Use a VM size with more data-disk slots (AKS D4s_v5 allows 8)",
        ),
      );
  }
  return checks;
}

export function evaluateReleaseNamespace(namespaceInput: unknown) {
  const labels =
    z
      .object({ metadata: z.object({ labels: z.record(z.string(), z.string()).optional() }) })
      .safeParse(namespaceInput).data?.metadata.labels ?? {};
  const enforce = labels["pod-security.kubernetes.io/enforce"];
  return enforce === "restricted"
    ? fail(
        "psa.release-namespace",
        "The release Namespace enforces the restricted Pod Security level. Factory runs as root with all capabilities dropped.",
        "kubectl label --overwrite ns RELEASE_NAMESPACE pod-security.kubernetes.io/enforce=baseline",
      )
    : pass(
        "psa.release-namespace",
        `Release Namespace Pod Security enforce level is ${enforce ?? "unset"}`,
      );
}

export function evaluateAdmission(
  id: string,
  subject: string,
  result: { exitCode: number; stderr: string },
  podSecurityLabelled: boolean,
) {
  if (result.exitCode === 0)
    return pass(id, `${subject} was admitted by the API server (server-side dry run)`);
  const detail = result.stderr.trim().split("\n").slice(0, 3).join(" ");
  const policy = /pod-security|PodSecurity/i.test(detail)
    ? "Pod Security Admission denied it"
    : /gatekeeper|azurepolicy|constraint|admission webhook/i.test(detail)
      ? "A policy engine (Azure Policy, Gatekeeper, Kyverno) denied it"
      : "Admission denied it";
  return fail(
    id,
    `${subject} was refused. ${policy}: ${detail}`,
    podSecurityLabelled
      ? "Exempt Namespaces labelled app.kubernetes.io/managed-by=open-software-factory from the policy that denies privileged Pods, or remove that policy for the cluster"
      : "Factory creates worker Namespaces without Pod Security labels. Set the cluster default to privileged for them, or exempt the policy, then rerun",
  );
}

export interface NodeFacts {
  readonly release: string;
  readonly machine: string;
  readonly pageSize: number;
  readonly cgroupFilesystem: string | null;
  readonly cgroupControllers: string | null;
  readonly config: {
    readonly source: string | null;
    readonly values: Record<string, string>;
    readonly listed?: number;
  };
  readonly filesystems: readonly string[];
  readonly btf: boolean;
  readonly userfaultfd: { readonly available: boolean; readonly errno: number } | null;
  readonly unprivilegedUserfaultfd: string | null;
  readonly nsLastPidWritable: boolean;
  readonly maxUserNamespaces: number | null;
  readonly devices: Record<string, boolean>;
  readonly doctor: { readonly exitCode: number; readonly stdout: string } | null;
}

interface ConfigRequirement {
  readonly option: string;
  readonly why: string;
  readonly required: boolean;
  readonly filesystem?: string;
}

// Hard rows are requirements of CRIU's `criu check`, Sysbox system containers, or code the
// standalone runtime runs (loop-backed ext4 store, BPF task iterator, veth NAT).
export const kernelConfigRequirements: readonly ConfigRequirement[] = [
  { option: "CONFIG_USER_NS", why: "Sysbox user-namespace containers", required: true },
  { option: "CONFIG_PID_NS", why: "CRIU and Sysbox PID namespaces", required: true },
  { option: "CONFIG_NET_NS", why: "private worker and Sandbox networks", required: true },
  { option: "CONFIG_UTS_NS", why: "Sysbox containers", required: true },
  { option: "CONFIG_IPC_NS", why: "Sysbox containers", required: true },
  { option: "CONFIG_CGROUPS", why: "worker cgroup delegation", required: true },
  { option: "CONFIG_CHECKPOINT_RESTORE", why: "CRIU (ns_last_pid, map_files)", required: true },
  { option: "CONFIG_FHANDLE", why: "CRIU file handles", required: true },
  { option: "CONFIG_EVENTFD", why: "CRIU", required: true },
  { option: "CONFIG_EPOLL", why: "CRIU", required: true },
  { option: "CONFIG_INOTIFY_USER", why: "CRIU and shared-source watches", required: true },
  { option: "CONFIG_FANOTIFY", why: "CRIU", required: true },
  { option: "CONFIG_UNIX_DIAG", why: "CRIU socket dump", required: true },
  { option: "CONFIG_INET_DIAG", why: "CRIU socket dump", required: true },
  { option: "CONFIG_PACKET_DIAG", why: "CRIU socket dump", required: true },
  { option: "CONFIG_NETLINK_DIAG", why: "CRIU socket dump", required: true },
  { option: "CONFIG_SECCOMP_FILTER", why: "Sysbox syscall interception", required: true },
  {
    option: "CONFIG_OVERLAY_FS",
    why: "container root filesystems",
    required: true,
    filesystem: "overlay",
  },
  { option: "CONFIG_FUSE_FS", why: "Sysbox FUSE emulation", required: true, filesystem: "fuse" },
  { option: "CONFIG_BLK_DEV_LOOP", why: "the bounded store's loop device", required: true },
  {
    option: "CONFIG_EXT4_FS",
    why: "the bounded store's filesystem",
    required: true,
    filesystem: "ext4",
  },
  { option: "CONFIG_BPF_SYSCALL", why: "timer-state BPF task iterator", required: true },
  {
    option: "CONFIG_DEBUG_INFO_BTF",
    why: "BTF layouts read by the timer-state iterator",
    required: true,
  },
  { option: "CONFIG_KALLSYMS", why: "timer-state symbol lookup", required: true },
  { option: "CONFIG_VETH", why: "per-Sandbox outbound network", required: true },
  { option: "CONFIG_NF_NAT", why: "outbound NAT rules", required: true },
  { option: "CONFIG_USERFAULTFD", why: "CRIU lazy pages", required: false },
  { option: "CONFIG_MEM_SOFT_DIRTY", why: "CRIU incremental dumps", required: false },
];

export const nodeProbeOptions = kernelConfigRequirements.map((item) => item.option);

export function evaluateNodeFacts(facts: NodeFacts) {
  const checks: PreflightCheck[] = [];
  checks.push(
    facts.pageSize === 4096
      ? pass("kernel.page-size", "4096-byte pages")
      : fail(
          "kernel.page-size",
          `Page size is ${facts.pageSize}; the worker admits only 4096-byte pages`,
          "Use a node image with a 4 KiB page kernel (not 64 KiB arm64 kernels)",
        ),
  );
  const unified = facts.cgroupFilesystem === "cgroup2";
  const controllers = (facts.cgroupControllers ?? "").split(/\s+/);
  const missing = ["cpu", "memory", "pids"].filter((item) => !controllers.includes(item));
  checks.push(
    unified && !missing.length
      ? pass("kernel.cgroup-v2", `cgroup v2 with ${controllers.join(", ")}`)
      : fail(
          "kernel.cgroup-v2",
          unified
            ? `cgroup v2 lacks controllers ${missing.join(", ")}`
            : `/sys/fs/cgroup is ${facts.cgroupFilesystem ?? "absent"}, not cgroup2`,
          "Use a node image with the unified cgroup v2 hierarchy (AKS Ubuntu 22.04 and newer)",
        ),
  );
  if (facts.config.source === null) {
    checks.push(
      warn(
        "kernel.config",
        "The kernel configuration is not readable (/proc/config.gz absent, no /boot/config-RELEASE). Falling back to loaded filesystems.",
        "Mount the node's /boot into the probe Pod or run `factorybox doctor` on the node",
      ),
    );
    for (const item of kernelConfigRequirements)
      if (item.filesystem && !facts.filesystems.includes(item.filesystem))
        checks.push(
          warn(
            `kernel.${item.option.replace(/^CONFIG_/, "").toLowerCase()}`,
            `Filesystem ${item.filesystem} is not loaded; needed for ${item.why}. It may autoload on first use.`,
            "Confirm with the kernel configuration or `factorybox doctor`",
          ),
        );
  } else {
    for (const item of kernelConfigRequirements) {
      const value = facts.config.values[item.option];
      const present = value === "y" || value === "m";
      const id = `kernel.${item.option.replace(/^CONFIG_/, "").toLowerCase()}`;
      if (present) checks.push(pass(id, `${item.option}=${value} (${item.why})`));
      else if (value === undefined && (facts.config.listed ?? Infinity) < 1000)
        // A stripped configuration (some development nodes) omits options the kernel has built in.
        checks.push(
          warn(
            id,
            `${item.option} is not listed in the kernel configuration; needed for ${item.why}`,
            "Confirm with `factorybox doctor`, which the worker.doctor check runs",
          ),
        );
      else if (item.required)
        checks.push(
          fail(
            id,
            `${item.option} is ${value ?? "unset"}; needed for ${item.why}`,
            "Use a node image whose kernel enables it. Ubuntu LTS kernels enable all of these",
          ),
        );
      else
        checks.push(
          warn(
            id,
            `${item.option} is ${value ?? "unset"}; ${item.why} would be unavailable`,
            "Optional",
          ),
        );
    }
  }
  checks.push(
    facts.btf
      ? pass("kernel.btf", "/sys/kernel/btf/vmlinux is present")
      : fail(
          "kernel.btf",
          "/sys/kernel/btf/vmlinux is missing",
          "Use a kernel built with CONFIG_DEBUG_INFO_BTF=y",
        ),
  );
  checks.push(
    facts.userfaultfd?.available
      ? pass(
          "kernel.userfaultfd",
          `userfaultfd syscall works (vm.unprivileged_userfaultfd=${facts.unprivilegedUserfaultfd ?? "unknown"}; the worker is privileged)`,
        )
      : warn(
          "kernel.userfaultfd",
          `userfaultfd failed with errno ${facts.userfaultfd?.errno ?? "unknown"}. CRIU lazy restore would be unavailable.`,
          "Run the probe privileged, or set vm.unprivileged_userfaultfd=1 on the node pool",
        ),
  );
  checks.push(
    facts.nsLastPidWritable
      ? pass("kernel.ns-last-pid", "/proc/sys/kernel/ns_last_pid is writable (CRIU PID restore)")
      : fail(
          "kernel.ns-last-pid",
          "/proc/sys/kernel/ns_last_pid is not writable",
          "Needs CONFIG_CHECKPOINT_RESTORE and a privileged container",
        ),
  );
  checks.push(
    facts.maxUserNamespaces === null
      ? warn(
          "kernel.user-namespaces",
          "user.max_user_namespaces is unreadable from the probe Pod",
          "Confirm with `factorybox doctor`, which the worker.doctor check runs",
        )
      : facts.maxUserNamespaces > 0
        ? pass("kernel.user-namespaces", `user.max_user_namespaces=${facts.maxUserNamespaces}`)
        : fail(
            "kernel.user-namespaces",
            "user.max_user_namespaces is 0",
            "sysctl user.max_user_namespaces=63359 on the node pool",
          ),
  );
  for (const [device, present] of Object.entries(facts.devices))
    if (!present)
      checks.push(
        warn(
          `kernel.dev-${device}`,
          `/dev/${device} is absent. It appears when the module autoloads on first use.`,
          `modprobe ${device === "fuse" ? "fuse" : "loop"} on the node if the worker cannot start`,
        ),
      );
  checks.push(workerDoctorCheck(facts));
  return checks;
}

// Runs in the worker image (python3 is already required by the store initializer).
// Read-only except for the throwaway userfaultfd descriptor it opens and closes.
export function nodeProbeProgram() {
  return `import ctypes, gzip, json, os, platform, subprocess
OPTIONS = set(json.loads(${JSON.stringify(JSON.stringify(nodeProbeOptions))}))
def read(path, limit=1 << 22):
    try:
        with open(path, "rb") as f:
            return f.read(limit).decode("utf-8", "replace")
    except OSError:
        return None
release = platform.release()
facts = {"release": release, "machine": platform.machine(), "pageSize": os.sysconf("SC_PAGE_SIZE")}
facts["cgroupFilesystem"] = None
for line in (read("/proc/self/mountinfo") or "").splitlines():
    left, _, right = line.partition(" - ")
    fields = left.split()
    if len(fields) > 4 and fields[4] == "/sys/fs/cgroup" and right:
        facts["cgroupFilesystem"] = right.split()[0]
facts["cgroupControllers"] = read("/sys/fs/cgroup/cgroup.controllers")
text, source = None, None
try:
    with gzip.open("/proc/config.gz", "rt") as f:
        text, source = f.read(), "/proc/config.gz"
except OSError:
    pass
if text is None:
    for path in ("/host/boot/config-" + release, "/host/boot/config"):
        text = read(path)
        if text is not None:
            source = path
            break
values = {}
listed = 0
for line in (text or "").splitlines():
    if line.startswith("CONFIG_") or (line.startswith("# CONFIG_") and line.endswith(" is not set")):
        listed += 1
    if line.startswith("CONFIG_"):
        key, _, value = line.partition("=")
        if key in OPTIONS:
            values[key] = value
    elif line.startswith("# CONFIG_") and line.endswith(" is not set"):
        key = line[2:].split()[0]
        if key in OPTIONS:
            values[key] = "n"
facts["config"] = {"source": source, "values": values, "listed": listed}
facts["filesystems"] = [l.split()[-1] for l in (read("/proc/filesystems") or "").splitlines() if l.strip()]
facts["btf"] = os.path.exists("/sys/kernel/btf/vmlinux")
number = {"x86_64": 323, "aarch64": 282}.get(platform.machine())
facts["userfaultfd"] = None
if number:
    libc = ctypes.CDLL(None, use_errno=True)
    fd = libc.syscall(number, 0o2004000)
    facts["userfaultfd"] = {"available": fd >= 0, "errno": 0 if fd >= 0 else ctypes.get_errno()}
    if fd >= 0:
        os.close(fd)
unprivileged = read("/proc/sys/vm/unprivileged_userfaultfd")
facts["unprivilegedUserfaultfd"] = unprivileged.strip() if unprivileged else None
facts["nsLastPidWritable"] = os.access("/proc/sys/kernel/ns_last_pid", os.W_OK)
namespaces = read("/proc/sys/user/max_user_namespaces")
facts["maxUserNamespaces"] = int(namespaces) if namespaces and namespaces.strip().isdigit() else None
facts["devices"] = {"loop-control": os.path.exists("/dev/loop-control"), "fuse": os.path.exists("/dev/fuse")}
facts["doctor"] = None
binary = "/opt/factorybox/factorybox"
if os.path.exists(binary):
    try:
        done = subprocess.run([binary, "doctor"], capture_output=True, timeout=30)
        facts["doctor"] = {"exitCode": done.returncode, "stdout": (done.stdout + done.stderr).decode("utf-8", "replace")[:2000]}
    except Exception as error:
        facts["doctor"] = {"exitCode": 1, "stdout": str(error)}
print("FACTORY_PREFLIGHT " + json.dumps(facts))
`;
}

export function parseNodeFacts(logs: string): NodeFacts | null {
  const line = logs
    .split("\n")
    .reverse()
    .find((item) => item.startsWith("FACTORY_PREFLIGHT "));
  if (!line) return null;
  try {
    return JSON.parse(line.slice("FACTORY_PREFLIGHT ".length)) as NodeFacts;
  } catch {
    return null;
  }
}

// `factorybox doctor` is the worker's own capability gate. A node that passes it but whose
// kernel the build has not verified is usable and only worth a warning.
function workerDoctorCheck(facts: NodeFacts) {
  if (!facts.doctor)
    return skip(
      "worker.doctor",
      "The worker image has no factorybox executable at /opt/factorybox/factorybox",
    );
  const output = facts.doctor.stdout.trim();
  if (facts.doctor.exitCode !== 0)
    return fail(
      "worker.doctor",
      `factorybox doctor refuses this node: ${output.slice(0, 300)}`,
      `The worker's capability gate rejected kernel ${facts.release}. Read its message for the missing capability, use a node image that provides it, or use a Factorybox release whose gate admits it (standalone repository: internal/platform).`,
    );
  if (doctorQualification(output) === "unverified")
    return warn(
      "worker.doctor",
      `factorybox doctor accepts this node, but kernel ${facts.release} is not verified by this Factorybox build: ${output.slice(0, 200)}`,
      "The capability gate passed, so Factory will admit the node. Run your own workload acceptance before relying on it, or choose a verified kernel.",
    );
  return pass("worker.doctor", `factorybox doctor accepts this node: ${output.slice(0, 200)}`);
}

function doctorQualification(output: string) {
  try {
    const parsed = JSON.parse(output) as {
      qualification?: unknown;
      platform?: { qualification?: unknown };
    };
    const value = parsed.qualification ?? parsed.platform?.qualification;
    if (value === "verified" || value === "unverified") return value;
  } catch {}
  return /["']?qualification["']?\s*[:=]\s*["']?(verified|unverified)\b/.exec(output)?.[1] as
    | "verified"
    | "unverified"
    | undefined;
}
