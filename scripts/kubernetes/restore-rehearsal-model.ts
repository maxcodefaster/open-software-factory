// Pure helpers for restore-rehearsal.ts. Nothing here touches the cluster or the file system.

export const rehearsalOwnerLabel = "factory.dev/rehearsal-owner";
export const rehearsalManagedBy = "factory-restore-rehearsal";
const namespacePattern = /^factory-restore-rehearsal-([0-9a-f]{8})$/;

export function rehearsalNamespace(id: string) {
  if (!/^[0-9a-f]{8}$/.test(id)) throw new Error("A rehearsal id is eight lowercase hex digits");
  return `factory-restore-rehearsal-${id}`;
}

export function rehearsalIDFromNamespace(namespace: string) {
  return namespacePattern.exec(namespace)?.[1] ?? null;
}

export function factoryName(release: string) {
  return release.slice(0, 40).replace(/-+$/, "");
}

export type BackupEntry = { name: string; complete: boolean };

const setPattern = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

export function newestCompleteSet(entries: readonly BackupEntry[]) {
  return (
    entries
      .filter((entry) => entry.complete && setPattern.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .at(-1) ?? null
  );
}

export function setAgeMinutes(name: string, now: Date) {
  const match = setPattern.exec(name);
  if (!match) throw new Error(`${name} is not a backup set name`);
  const [, year, month, day, hour, minute, second] = match;
  const taken = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return (now.getTime() - taken) / 60_000;
}

export function receiptName(now: Date) {
  return `${now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}.json`;
}

// Kubernetes quantity to MiB. Only memory-style suffixes occur in resource requests.
export function quantityMiB(quantity: string) {
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|M|G|T|m)?$/.exec(quantity.trim());
  if (!match?.[1]) throw new Error(`Unsupported quantity ${quantity}`);
  const value = Number(match[1]);
  const bytes: Record<string, number> = {
    "": 1,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    k: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    m: 1e-3,
  };
  return (value * (bytes[match[2] ?? ""] ?? 1)) / 1024 ** 2;
}

type Requests = { resources?: { requests?: { memory?: string } } };
type PodLike = {
  status?: { phase?: string };
  spec?: { containers?: Requests[]; initContainers?: Requests[] };
};

export function podMemoryRequestMiB(pod: PodLike) {
  if (pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") return 0;
  const request = (container: Requests) =>
    quantityMiB(container.resources?.requests?.memory ?? "0");
  const main = (pod.spec?.containers ?? []).reduce((sum, container) => sum + request(container), 0);
  const init = Math.max(0, ...(pod.spec?.initContainers ?? []).map(request));
  return Math.max(main, init);
}

export function memoryHeadroomMiB(allocatable: string, pods: readonly PodLike[]) {
  return quantityMiB(allocatable) - pods.reduce((sum, pod) => sum + podMemoryRequestMiB(pod), 0);
}

// Small requests keep the scratch installation schedulable on a node that already runs the
// retained one. Limits stay as the live installation has them.
export const scratchRequestsMiB = {
  postgres: 64,
  forgejo: 96,
  objects: 32,
  openbao: 64,
  zero: 128,
  factory: 256,
} as const;

export function scratchRequestTotalMiB() {
  return Object.values(scratchRequestsMiB).reduce((sum, value) => sum + value, 0);
}

type Values = Record<string, unknown>;

function record(value: unknown): Values {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Values) : {};
}

function withRequests(live: unknown, memoryMiB: number, cpu: string) {
  const resources = record(live);
  return {
    ...resources,
    requests: { ...record(resources["requests"]), cpu, memory: `${memoryMiB}Mi` },
  };
}

export type ScratchValuesInput = { release: string; image: string };

// The live values with only what a scratch copy must change: the image, backups, the execution
// reserve, scheduling requests and the Secrets copied from the live release. The browser origins
// stay as they are because the restored database records them as the Forge identity. Nothing
// exposes them, so a scratch installation cannot collide with the live one.
export function scratchValues(live: Values, input: ScratchValuesInput): Values {
  const name = factoryName(input.release);
  const service = (key: string, memoryMiB: number, cpu: string, extra: Values = {}) => ({
    ...record(live[key]),
    ...extra,
    resources: withRequests(record(live[key])["resources"], memoryMiB, cpu),
  });
  const next: Values = {
    ...live,
    image: input.image,
    imagePullPolicy: "IfNotPresent",
    backup: { ...record(live["backup"]), enabled: false },
    ingress: { ...record(live["ingress"]), enabled: false },
    executionReserveTarget: 0,
    existingSecrets: {
      ...record(live["existingSecrets"]),
      credentials: `${name}-credentials`,
      objects: `${name}-objects`,
    },
    postgres: service("postgres", scratchRequestsMiB.postgres, "25m"),
    forgejo: service("forgejo", scratchRequestsMiB.forgejo, "25m"),
    objectStorage: service("objectStorage", scratchRequestsMiB.objects, "25m"),
    openbao: service("openbao", scratchRequestsMiB.openbao, "25m", {
      recovery: { enabled: false },
    }),
    zero: service("zero", scratchRequestsMiB.zero, "50m"),
    resources: withRequests(live["resources"], scratchRequestsMiB.factory, "100m"),
  };
  return next;
}

export type Identity = {
  namespace: string;
  release: string;
  factoryURL: string;
  forgeURL: string;
  storageClass: string;
};

// start.ts refuses a state claim whose installation identity differs from the running one. A
// rehearsal runs in another Namespace, so it rewrites the restored file to the scratch identity.
export function rewriteInstallationIdentity(retained: string, scratch: Identity) {
  const previous = JSON.parse(retained) as Record<string, unknown>;
  for (const key of ["namespace", "release", "factoryURL", "forgeURL", "storageClass"])
    if (typeof previous[key] !== "string")
      throw new Error(`The retained installation identity has no ${key}`);
  return JSON.stringify(scratch);
}

const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Cluster Service addresses embed the Namespace (`<service>.<namespace>.svc`). The restored data
// records some of them, so a restore into another Namespace has to rewrite them.
export function rewriteServiceNamespace(text: string, from: string, to: string) {
  if (!namePattern.test(from) || !namePattern.test(to)) throw new Error("Invalid Namespace");
  return text.replaceAll(`.${from}.svc`, `.${to}.svc`);
}

// The three Factory columns that hold an in-cluster address: the Forge discovery document, the
// Project repository and the wiki webhook target. Triggers that protect them are skipped for this
// one session, and each statement reports its row count.
export function namespaceRewriteSQL(from: string, to: string) {
  if (!namePattern.test(from) || !namePattern.test(to)) throw new Error("Invalid Namespace");
  const targets = [
    ["factory.forge_connection", "discovery_url"],
    ["factory.project", "repository_url"],
    ["factory.wiki_source_update", "target_url"],
  ] as const;
  return [
    "SET session_replication_role = replica;",
    ...targets.map(
      ([table, column]) =>
        `UPDATE ${table} SET ${column} = replace(${column}, '.${from}.svc', '.${to}.svc') WHERE ${column} LIKE '%.${from}.svc%';`,
    ),
  ].join("\n");
}

function policyLabels(id: string) {
  return { [rehearsalOwnerLabel]: id, "app.kubernetes.io/managed-by": rehearsalManagedBy };
}

export function holdPolicy(id: string) {
  const name = `restore-rehearsal-hold-${id}`;
  return [
    {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicy",
      metadata: { name, labels: policyLabels(id) },
      spec: {
        failurePolicy: "Fail",
        matchConstraints: {
          resourceRules: [
            {
              apiGroups: [""],
              apiVersions: ["v1"],
              operations: ["CREATE"],
              resources: ["pods"],
            },
          ],
        },
        validations: [
          {
            expression:
              '!(has(object.metadata.labels) && "app.kubernetes.io/component" in object.metadata.labels && object.metadata.labels["app.kubernetes.io/component"] in ["factory", "zero"])',
            message: "The restore rehearsal holds Factory and Zero until the data is restored",
          },
        ],
      },
    },
    {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicyBinding",
      metadata: { name, labels: policyLabels(id) },
      spec: {
        policyName: name,
        validationActions: ["Deny"],
        matchResources: { namespaceSelector: { matchLabels: { [rehearsalOwnerLabel]: id } } },
      },
    },
  ];
}

// The restored database names the live Factorybox worker and its Sandboxes by Namespace. A scratch
// Factory holds the same cluster-wide authority as the live one, so this policy limits what its
// ServiceAccount may write to its own Namespace and the storage check Factory creates at start.
// Reads stay open. Other users and ServiceAccounts are not matched.
export function jailPolicy(id: string, namespace: string, serviceAccount: string) {
  const name = `restore-rehearsal-jail-${id}`;
  return [
    {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicy",
      metadata: { name, labels: policyLabels(id) },
      spec: {
        failurePolicy: "Fail",
        matchConstraints: {
          resourceRules: [
            {
              apiGroups: ["*"],
              apiVersions: ["*"],
              operations: ["CREATE", "UPDATE", "DELETE", "CONNECT"],
              resources: ["*/*"],
            },
          ],
        },
        matchConditions: [
          {
            name: "rehearsal-service-account",
            expression: `request.userInfo.username == "system:serviceaccount:${namespace}:${serviceAccount}"`,
          },
        ],
        validations: [
          {
            expression: [
              '(request.resource.resource == "namespaces" && request.name.startsWith("factory-storage-check-"))',
              'request.resource.resource == "persistentvolumes"',
              `(request.resource.resource != "namespaces" && (request.namespace == "${namespace}" || request.namespace.startsWith("factory-storage-check-")))`,
            ].join(" || "),
            message: `The restore rehearsal may only write to ${namespace} and its storage check`,
          },
        ],
      },
    },
    {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "ValidatingAdmissionPolicyBinding",
      metadata: { name, labels: policyLabels(id) },
      spec: { policyName: name, validationActions: ["Deny"] },
    },
  ];
}

export type ToolboxInput = {
  id: string;
  name: string;
  image: string;
  release: string;
  scratchGiB: number;
  objectsSecret: string;
  objectsEndpoint: string;
};

export function toolboxPod(input: ToolboxInput) {
  const name = factoryName(input.release);
  const claims = [
    ["forgejo-data", `data-${name}-forgejo-0`, "/var/lib/gitea"],
    ["forgejo-config", `config-${name}-forgejo-0`, "/etc/gitea"],
    ["openbao-data", `data-${name}-openbao-0`, "/bao/data"],
    ["zero-data", `data-${name}-zero-0`, "/zero"],
    ["state", `${name}-state`, "/var/lib/factory"],
  ] as const;
  const secret = (key: string) => ({ secretKeyRef: { name: input.objectsSecret, key } });
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: input.name,
      labels: { "factory.dev/rehearsal-toolbox": "true", [rehearsalOwnerLabel]: input.id },
    },
    spec: {
      restartPolicy: "Never",
      terminationGracePeriodSeconds: 1,
      automountServiceAccountToken: false,
      containers: [
        {
          name: "tools",
          image: input.image,
          command: ["sleep", "7200"],
          env: [
            { name: "HOME", value: "/tmp" },
            { name: "RCLONE_CONFIG_S3_TYPE", value: "s3" },
            { name: "RCLONE_CONFIG_S3_PROVIDER", value: "Other" },
            { name: "RCLONE_CONFIG_S3_ENDPOINT", value: input.objectsEndpoint },
            { name: "RCLONE_CONFIG_S3_REGION", value: "garage" },
            { name: "RCLONE_CONFIG_S3_FORCE_PATH_STYLE", value: "true" },
            { name: "RCLONE_CONFIG_S3_ACCESS_KEY_ID", valueFrom: secret("access-key-id") },
            { name: "RCLONE_CONFIG_S3_SECRET_ACCESS_KEY", valueFrom: secret("secret-access-key") },
          ],
          resources: {
            requests: { cpu: "10m", memory: "16Mi" },
            limits: { cpu: "1", memory: "512Mi" },
          },
          volumeMounts: [
            ...claims.map(([volume, , path]) => ({ name: volume, mountPath: path })),
            { name: "restore", mountPath: "/restore" },
          ],
        },
      ],
      volumes: [
        ...claims.map(([volume, claim]) => ({
          name: volume,
          persistentVolumeClaim: { claimName: claim },
        })),
        { name: "restore", emptyDir: { sizeLimit: `${Math.max(1, input.scratchGiB)}Gi` } },
      ],
    },
  };
}

// The chart opens Garage to the backup Job only, and a rehearsal renders without backups. This
// admits the toolbox, which writes the object mirror back.
export function toolboxNetworkPolicy(id: string, release: string) {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: `${factoryName(release)}-allow-rehearsal-toolbox`,
      labels: { [rehearsalOwnerLabel]: id },
    },
    spec: {
      podSelector: {
        matchLabels: {
          "app.kubernetes.io/instance": release,
          "app.kubernetes.io/component": "objects",
        },
      },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [{ podSelector: { matchLabels: { "factory.dev/rehearsal-toolbox": "true" } } }],
          ports: [{ protocol: "TCP", port: 3900 }],
        },
      ],
    },
  };
}

export type Comparison = {
  equal: boolean;
  compared: number;
  missing: string[];
  extra: string[];
  different: Array<{ key: string; live: string; scratch: string }>;
};

export function compareMaps(
  live: ReadonlyMap<string, string>,
  scratch: ReadonlyMap<string, string>,
): Comparison {
  const missing = [...live.keys()].filter((key) => !scratch.has(key)).sort();
  const extra = [...scratch.keys()].filter((key) => !live.has(key)).sort();
  const different = [...live.entries()]
    .flatMap(([key, value]) => {
      const other = scratch.get(key);
      return other !== undefined && other !== value ? [{ key, live: value, scratch: other }] : [];
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  return {
    equal: !missing.length && !extra.length && !different.length,
    compared: live.size,
    missing,
    extra,
    different,
  };
}

// Tables whose contents must be identical after a restore: projects, tickets and changes, wiki
// pages and revisions, users, model and MCP connections, attachment metadata and Forgejo links.
export const keyTables = [
  "auth.user",
  "auth.account",
  "factory.administrator",
  "factory.project",
  "factory.project_membership",
  "factory.epic",
  "factory.change",
  "factory.requirement_revision",
  "factory.knowledge_page",
  "factory.knowledge_revision",
  "factory.model_connection_version",
  "factory.model_role_connection",
  "factory.mcp_library",
  "factory.mcp_revision",
  "factory.mcp_connection",
  "factory.attachment",
  "factory.attachment_reference",
  "factory.attachment_storage",
  "factory.skill_revision",
  "factory.forge_connection",
] as const;

// One row per base table: name|row count. query_to_xml lets one statement count every table.
export const rowCountSQL = `SELECT table_schema || '.' || table_name || '|' ||
  (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
FROM information_schema.tables
WHERE table_schema IN ('auth', 'factory') AND table_type = 'BASE TABLE' ORDER BY 1`;

// Rows of a foreign key without a parent are listed by files/backup/foreign-keys.sql, the query the
// backup Job runs. The server enforces the constraints on writes, but a bulk delete with triggers
// disabled leaves orphans that a restore rejects when it recreates the constraint, so the
// rehearsal looks before it backs anything up.
export function orphanedConstraints(output: string) {
  return output
    .split("\n")
    .map((line) => line.trim().split("|"))
    .filter((columns) => columns.length === 3 && Number(columns[2]) > 0)
    .map(([constraint = "", table = "", rows = ""]) => ({ constraint, table, rows: Number(rows) }));
}

// Names of the foreign keys pg_restore could not recreate, from its diagnostics.
export function failedConstraints(diagnostics: string) {
  return [...diagnostics.matchAll(/ADD CONSTRAINT (\S+) FOREIGN KEY/g)]
    .map((match) => match[1] ?? "")
    .sort();
}

export function restoreErrorCount(diagnostics: string) {
  return diagnostics.split("\n").filter((line) => line.startsWith("pg_restore: error:")).length;
}

// One row per table: name|md5 of every row in a stable order.
export function checksumSQL(tables: readonly string[]) {
  return tables
    .map((table) => {
      if (!/^[a-z_]+\.[a-z_]+$/.test(table)) throw new Error(`Unsafe table name ${table}`);
      return `SELECT '${table}|' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), 'empty') FROM ${table} t`;
    })
    .join(" UNION ALL ");
}

export function parsePairs(output: string) {
  return new Map(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("|");
        if (separator < 1) throw new Error(`Unexpected row ${JSON.stringify(line)}`);
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      }),
  );
}

// rclone lsf --format sp prints "size;path". The map is path to size.
export function parseObjectListing(output: string) {
  return new Map(
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(";");
        if (separator < 0) throw new Error(`Unexpected listing row ${JSON.stringify(line)}`);
        return [line.slice(separator + 1), line.slice(0, separator)] as const;
      }),
  );
}

export type Step = { name: string; ok: boolean; detail: string };

export function summarize(steps: readonly Step[]) {
  return {
    ok: steps.every((step) => step.ok),
    passed: steps.filter((step) => step.ok).length,
    failed: steps.filter((step) => !step.ok).map((step) => step.name),
  };
}
