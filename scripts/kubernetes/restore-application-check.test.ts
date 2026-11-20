import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import type * as https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DetailedPeerCertificate } from "node:tls";
import {
  type ApplicationFixture,
  type ApplicationWitnesses,
  applicationBuildTree,
  applicationSQL,
  type Command,
  checkRestoredApplication,
  type HTTPRequest,
  type HTTPResponse,
  historyTables,
  idleRules,
  loadApplicationFixture,
  pinnedApplicationRequest,
  type Wire,
} from "./restore-application-check";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const owner = "a".repeat(32);
const ownerLabel = "factory.restore-application.owner";
const binding = "factory.restore-application.backup";
const identity = (name: string, n: number) => ({ name, uid: uid(n) });
const image = `registry.example/factory@sha256:${"b".repeat(64)}`;
const response = (
  body: unknown,
  headers: HTTPResponse["headers"] = {},
  status = 200,
): HTTPResponse => ({ status, headers, body: Buffer.from(JSON.stringify(body)) });
const clone = <T>(value: T): T => structuredClone(value);
const finalizedHistory = [
  "workspace_submission",
  "change_commit_operation",
  "usage_operation",
  "usage_entry",
  "usage_replay_cursor",
  "model_role_probe",
  "knowledge_generation",
];
// Independent contract, deliberately not derived from the production historyTables.
const workflowHistory = [
  "change_agent_session",
  "branch_create_operation",
  "pull_request_operation",
  "verification",
  "candidate_review",
  "review_scenario",
  "review_feedback",
  "review_feedback_message",
  "review_feedback_command",
  "delivery_approval",
  "merge_operation",
  "promotion_operation",
  "execution_policy_command",
];
function historyRow<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw Error("Synthetic history row required");
  return row;
}
function historyRows() {
  return {
    workspace_submission: [
      {
        id: uid(60),
        workspace_id: uid(61),
        actor_id: uid(30),
        prepare_attempted_at: "2026-11-17T10:00:00Z",
      },
    ],
    change_commit_operation: [
      {
        id: uid(60),
        runtime_attempt_id: uid(62),
        change_id: uid(63),
        created_by: uid(30),
        idempotency_key: `workspace:${uid(60)}`,
        source: "workspace",
        state: "succeeded",
        completed_at: "2026-11-17T10:01:00Z",
        commit_sha: "a".repeat(40),
        observed_remote_sha: "a".repeat(40),
        last_error: null as string | null,
      },
    ],
    runtime_attempt: [{ id: uid(62), workspace_id: uid(61) }],
    development_workspace: [{ id: uid(61), change_id: uid(63), kind: "ticket" }],
    usage_operation: [
      {
        id: `probe:${uid(64)}`,
        settled_at: "2026-11-17T10:01:00Z",
        outcome: "unknown",
        purpose: "probe",
        engine: "mastra",
        project_id: null as string | null,
        user_id: uid(30),
        model: "recorded-model",
      },
    ],
    usage_entry: [
      {
        operation_id: `probe:${uid(64)}`,
        event_id: "unobserved",
        source: "unobserved",
        outcome: "unknown",
      },
    ],
    model_role_probe: [
      {
        command_id: uid(64),
        state: "uncertain",
        finished_at: "2026-11-17T10:01:00Z",
        role: "planning",
        created_by: uid(30),
        model_id: "recorded-model",
        result: "{}",
      },
    ],
    knowledge_generation: [
      {
        id: uid(65),
        state: "failed",
        completed_at: "2026-11-17T10:01:00Z",
        project_id: uid(31),
        created_by: uid(30),
      },
    ],
  };
}
function historyBusy(
  table: "workspace_submission" | "usage_operation",
  rows: ReturnType<typeof historyRows>,
) {
  const db = new Database(":memory:");
  try {
    // Evaluate the production predicate with SELECT-only synthetic CTEs, not a second
    // eligibility implementation. CTE names need no PostgreSQL schema qualifier.
    const ctes = Object.keys(rows).map((name) => {
      const columns = Object.keys(historyRows()[name as keyof typeof rows][0] ?? {});
      if (!columns.length) throw Error("Synthetic history columns required");
      return `"${name}" AS (SELECT ${columns.map((key) => `json_extract(value,'$.${key}') AS "${key}"`).join(",")} FROM json_each(?))`;
    });
    const predicate = idleRules[table];
    if (!predicate) throw Error("Production idle predicate required");
    const result = db
      .query(
        `WITH ${ctes.join(",")} SELECT count(*) AS busy FROM ${table} WHERE ${predicate.replaceAll("factory.", "")}`,
      )
      .get(...Object.values(rows).map((values) => JSON.stringify(values))) as { busy: number };
    return result.busy;
  } finally {
    db.close();
  }
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "factory-restored-application-")));
  const privateRoot = join(root, "private");
  await mkdir(privateRoot, { mode: 0o700 });
  const account = { id: uid(30), email: "restored@example.invalid" };
  const project = {
    id: uid(31),
    name: "Retained project",
    slug: "retained",
    repositoryUrl: "https://git.example.invalid/owned/retained.git",
    defaultBranch: "main",
    devcontainerPath: ".devcontainer/devcontainer.json",
  };
  const ticket = {
    id: uid(32),
    projectId: project.id,
    title: "Retained ticket",
    description: "Original human text",
    state: "backlog",
    version: 7,
  };
  const documents = [
    {
      id: uid(33),
      ordinal: 1,
      title: ticket.title,
      description: ticket.description,
      canonicalContent: "null",
      contentDigest: hash("null"),
      requirementRevisionId: null,
    },
  ];
  const expected: ApplicationWitnesses = {
    schema: 1,
    provenance: "independent-source-observation",
    backupWitnessDigest: hash("independent backup witnesses"),
    schemaDigest: hash("native baseline"),
    project,
    ticket,
    documents,
    requirements: [],
    requirementRevisionID: null,
    history: Object.fromEntries(
      [...historyTables, "other_tickets", "old_documents", "protected_ticket"].map((table) => [
        table,
        { rows: 1, sha256: hash(`independent ${table}`) },
      ]),
    ),
    source: {
      workspaceID: uid(34),
      leaseSHA256: hash("immutable service-owned source"),
      path: "src/unsaved-in-git.txt",
      bytes: 6,
      sha256: hash("Source"),
    },
    git: {
      owner: "owned",
      repository: "retained",
      commit: "c".repeat(40),
      path: "README.md",
      bytes: 3,
      sha256: hash("Git"),
      blob: "d".repeat(40),
    },
  };
  const backup = {
    schema: 1,
    owner,
    source: {
      chartRevision: "39d7969bb3acd93d0bc497a5748cce08ae435091",
      applicationRevision: "e".repeat(40),
      namespace: "factory",
      namespaceUID: uid(3),
      release: "factory",
      factoryOrigin: "https://factory.example.invalid",
      forgejoOrigin: "https://git.example.invalid",
      storageClass: "retained-storage",
    },
    set: "20261117T100209Z",
    status: "data-services-passed",
    components: {
      postgres: "passed",
      forgejo: "passed",
      state: "passed",
      objects: "passed",
      openbao: "passed",
    },
    cleanup: "confirmed",
    nativeActivation: "not-run-not-qualified",
    limits: {},
    witnessDigest: expected.backupWitnessDigest,
  };
  const build = {
    schema: 1,
    image,
    platformDigest: "f".repeat(64),
    applicationRevision: backup.source.applicationRevision,
    treeSHA256: hash("complete compiled tree"),
    functions: {
      getBootstrap: "opaque-bootstrap",
      getTicketDetail: "opaque-ticket",
      saveTicketDocument: "opaque-save",
    },
  };
  const secrets: Record<string, string> = {
    "auth-secret": "retained-auth",
    "admin-password": "retained-admin",
    "database-password": "retained-database",
    "zero-password": "retained-zero",
    "webhook-secret": "retained-hook",
  };
  const value: ApplicationFixture = {
    schema: 1,
    owner,
    exclusiveTarget: true,
    privateRoot,
    evidenceDirectory: join(root, "evidence"),
    kubeconfig: join(privateRoot, "kubeconfig"),
    ca: join(privateRoot, "ca.pem"),
    password: join(privateRoot, "password"),
    forgeToken: join(privateRoot, "forge-token"),
    account,
    backup: { file: join(privateRoot, "backup.json"), sha256: "" },
    build: { file: join(privateRoot, "build.json"), sha256: "" },
    witnesses: { file: join(privateRoot, "witnesses.json"), sha256: "" },
    source: { context: "retained-source", kubeSystemUID: uid(1), ingress: identity("factory", 4) },
    target: {
      context: "isolated-target",
      kubeSystemUID: uid(2),
      namespace: identity("factory", 5),
      deployment: identity("factory", 6),
      applicationPod: identity("factory-pod", 7),
      postgresPod: identity("factory-postgres-0", 8),
      forgejoPod: identity("factory-forgejo-0", 9),
      zeroPod: identity("factory-zero-0", 17),
      ingress: identity("factory", 10),
      factoryService: identity("factory-factory", 11),
      forgejoService: identity("factory-forgejo", 12),
      zeroService: identity("factory-zero", 18),
      postgresService: identity("factory-postgres", 16),
      configuration: identity("factory-config", 13),
      credentials: identity("restore-credentials", 14),
      address: "192.0.2.20",
    },
    credentialHashes: Object.fromEntries(Object.entries(secrets).map(([key, v]) => [key, hash(v)])),
    save: { commandID: uid(35), description: "One deliberate restored-application save" },
    limits: { seconds: 10, responseBytes: 1024 ** 2 },
  };
  const path = join(privateRoot, "application.json");
  const save = async () => {
    for (const [file, body] of [
      [value.backup, backup],
      [value.build, build],
      [value.witnesses, expected],
    ] as const) {
      const bytes = JSON.stringify(body);
      file.sha256 = hash(bytes);
      await writeFile(file.file, bytes, { mode: 0o600 });
    }
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  };
  const kubeconfig = {
    apiVersion: "v1",
    kind: "Config",
    contexts: [value.source, value.target].map((c) => ({
      name: c.context,
      context: { cluster: c.context, user: "owned" },
    })),
    clusters: [value.source, value.target].map((c, i) => ({
      name: c.context,
      cluster: {
        server: `https://192.0.2.${30 + i}:6443`,
        "certificate-authority-data": Buffer.from(
          "-----BEGIN CERTIFICATE-----\npublic only",
        ).toString("base64"),
      },
    })),
    users: [{ name: "owned", user: { token: "private-kubernetes-credential" } }],
  };
  for (const [file, bytes] of [
    [value.kubeconfig, JSON.stringify(kubeconfig)],
    [value.ca, "-----BEGIN CERTIFICATE-----\nsynthetic public CA\n-----END CERTIFICATE-----"],
    [value.password, "private-restored-password"],
    [value.forgeToken, "private-restored-forge-token-123456"],
  ])
    await writeFile(file ?? "", bytes ?? "", { mode: 0o600 });
  await save();
  return {
    root,
    path,
    value,
    expected,
    backup,
    build,
    kubeconfig,
    secrets,
    save,
    load: () => loadApplicationFixture(path, owner),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function target(f: Fixture) {
  const calls: { args: string[]; input: string | undefined }[] = [],
    requests: HTTPRequest[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: These observations deliberately include malformed Kubernetes objects.
  const objects = new Map<string, any>();
  const ns = f.value.target.namespace.name;
  const meta = (id: { name: string; uid: string }, namespaced = true) => ({
    ...id,
    ...(namespaced ? { namespace: ns } : {}),
    labels: { [ownerLabel]: owner },
  });
  const put = (context: string, kind: string, key: string, value: unknown) =>
    objects.set(`${context}/${kind}/${key}`, value);
  const source = f.value.source.context,
    to = f.value.target.context;
  put(source, "namespace", "kube-system", { metadata: meta(identity("kube-system", 1), false) });
  put(to, "namespace", "kube-system", { metadata: meta(identity("kube-system", 2), false) });
  put(source, "namespace", ns, { metadata: meta(identity(ns, 3), false) });
  put(to, "namespace", ns, { metadata: meta(f.value.target.namespace, false) });
  const env = [
    ...[
      ["FACTORY_AUTH_SECRET", "auth-secret"],
      ["FACTORY_ADMIN_PASSWORD", "admin-password"],
      ["FACTORY_DATABASE_PASSWORD", "database-password"],
      ["FACTORY_WIKI_WEBHOOK_SECRET", "webhook-secret"],
    ].map(([key, v]) => ({
      name: key,
      valueFrom: { secretKeyRef: { name: f.value.target.credentials.name, key: v } },
    })),
    {
      name: "DATABASE_URL",
      value: `postgresql://factory:$(FACTORY_DATABASE_PASSWORD)@factory-postgres.${ns}.svc:5432/factory`,
    },
  ];
  const container = {
    name: "factory",
    image,
    command: [
      "flock",
      "--nonblock",
      "--no-fork",
      "/var/lib/factory/bootstrap.lock",
      "bun",
      "scripts/kubernetes/start.ts",
    ],
    env,
    envFrom: [{ configMapRef: { name: f.value.target.configuration.name } }],
  };
  put(to, "deployment", "factory", {
    metadata: {
      ...meta(f.value.target.deployment),
      generation: 1,
      annotations: { [binding]: f.value.backup.sha256 },
    },
    spec: { replicas: 1, template: { spec: { containers: [clone(container)] } } },
    status: { observedGeneration: 1, readyReplicas: 1, updatedReplicas: 1 },
  });
  put(to, "replicaset", "factory-rs", {
    metadata: {
      ...meta(identity("factory-rs", 15)),
      ownerReferences: [
        { controller: true, kind: "Deployment", uid: f.value.target.deployment.uid },
      ],
    },
  });
  for (const [pod, role, ip] of [
    [f.value.target.applicationPod, "factory", "10.0.0.10"],
    [f.value.target.forgejoPod, "forgejo", "10.0.0.11"],
    [f.value.target.postgresPod, "postgres", "10.0.0.12"],
    [f.value.target.zeroPod, "zero", "10.0.0.13"],
  ] as const)
    put(to, "pod", pod.name, {
      metadata: {
        ...meta(pod),
        labels: { "app.kubernetes.io/instance": "factory", "app.kubernetes.io/component": role },
        ownerReferences:
          role === "factory"
            ? [{ controller: true, kind: "ReplicaSet", name: "factory-rs", uid: uid(15) }]
            : [],
      },
      spec: {
        containers:
          role === "factory"
            ? [clone(container)]
            : role === "zero"
              ? [
                  {
                    name: "zero",
                    image:
                      "docker.io/rocicorp/zero:1.12.0@sha256:213d3bc4c667458c2ca6b65c963db4e484298dc25586f3cd93033bbdeaf32cb1",
                    env: [
                      ...["ZERO_UPSTREAM_DB", "ZERO_CVR_DB", "ZERO_CHANGE_DB"].map((name) => ({
                        name,
                        value: `postgresql://factory:$(FACTORY_DATABASE_PASSWORD)@factory-postgres.${ns}.svc:5432/factory`,
                      })),
                      {
                        name: "FACTORY_DATABASE_PASSWORD",
                        valueFrom: {
                          secretKeyRef: {
                            name: f.value.target.credentials.name,
                            key: "database-password",
                          },
                        },
                      },
                      { name: "ZERO_QUERY_FORWARD_COOKIES", value: "true" },
                      { name: "ZERO_ENABLE_CRUD_MUTATIONS", value: "false" },
                      {
                        name: "ZERO_QUERY_URL",
                        value: `http://factory-internal.${ns}.svc:3000/api/zero/query`,
                      },
                    ],
                  },
                ]
              : [],
      },
      status: {
        phase: "Running",
        podIP: ip,
        containerStatuses:
          role === "factory"
            ? [
                {
                  name: "factory",
                  ready: true,
                  imageID: `registry.example/factory@sha256:${f.build.platformDigest}`,
                },
              ]
            : role === "zero"
              ? [{ name: "zero", ready: true }]
              : [],
      },
    });
  for (const [svc, pod, role, ip, port] of [
    [f.value.target.factoryService, f.value.target.applicationPod, "factory", "10.0.0.10", 3000],
    [f.value.target.forgejoService, f.value.target.forgejoPod, "forgejo", "10.0.0.11", 3000],
    [identity("factory-postgres", 16), f.value.target.postgresPod, "postgres", "10.0.0.12", 5432],
    [f.value.target.zeroService, f.value.target.zeroPod, "zero", "10.0.0.13", 4848],
    [identity("factory-internal", 19), f.value.target.applicationPod, "factory", "10.0.0.10", 3000],
  ] as const) {
    put(to, "service", svc.name, {
      metadata: meta(svc),
      spec: {
        type: "ClusterIP",
        ports: [
          { name: port === 5432 ? "postgres" : "http", port, targetPort: port, protocol: "TCP" },
        ],
        selector: { "app.kubernetes.io/instance": "factory", "app.kubernetes.io/component": role },
      },
    });
    put(to, "endpointslices", svc.name, {
      items: [
        {
          metadata: {
            namespace: ns,
            ownerReferences: [{ kind: "Service", uid: svc.uid, controller: true }],
          },
          ports: [{ name: port === 5432 ? "postgres" : "http", port, protocol: "TCP" }],
          endpoints: [
            {
              conditions: { ready: true },
              addresses: [ip],
              targetRef: { kind: "Pod", uid: pod.uid, name: pod.name, namespace: ns },
            },
          ],
        },
      ],
    });
  }
  const rules = [
    {
      host: "factory.example.invalid",
      http: {
        paths: [
          {
            path: "/zero",
            pathType: "Prefix",
            backend: { service: { name: f.value.target.zeroService.name, port: { number: 4848 } } },
          },
          {
            path: "/",
            pathType: "Prefix",
            backend: {
              service: { name: f.value.target.factoryService.name, port: { number: 3000 } },
            },
          },
        ],
      },
    },
    {
      host: "git.example.invalid",
      http: {
        paths: [
          {
            path: "/",
            pathType: "Prefix",
            backend: {
              service: { name: f.value.target.forgejoService.name, port: { number: 3000 } },
            },
          },
        ],
      },
    },
  ];
  for (const [ctx, id, ip] of [
    [source, f.value.source.ingress, "192.0.2.10"],
    [to, f.value.target.ingress, f.value.target.address],
  ] as const)
    put(ctx, "ingress", "factory", {
      metadata: meta(id),
      spec: {
        rules: clone(rules),
        tls: [{ secretName: "leaf-only", hosts: rules.map((r) => r.host) }],
      },
      status: { loadBalancer: { ingress: [{ ip }] } },
    });
  put(to, "ingresses", "--all-namespaces", { items: [objects.get(`${to}/ingress/factory`)] });
  put(to, "configmap", f.value.target.configuration.name, {
    metadata: meta(f.value.target.configuration),
    data: {
      FACTORY_BASE_URL: f.backup.source.factoryOrigin,
      FACTORY_FORGEJO_PUBLIC_URL: f.backup.source.forgejoOrigin,
      FACTORY_HELM_RELEASE: "factory",
      FACTORY_FORGEJO_API_URL: `http://factory-forgejo.${ns}.svc:3000/api/v1/`,
    },
  });
  put(to, "secret", f.value.target.credentials.name, {
    metadata: meta(f.value.target.credentials),
    data: Object.fromEntries(
      Object.entries(f.secrets).map(([key, v]) => [key, Buffer.from(v).toString("base64")]),
    ),
  });
  let saved = false,
    authenticated = false;
  // biome-ignore lint/suspicious/noExplicitAny: Negative cases deliberately corrupt every shape of a database observation.
  let dbHook: ((snapshot: any) => void) | undefined,
    httpHook: ((request: HTTPRequest) => HTTPResponse | undefined) | undefined;
  const newDoc = () => ({
    ...f.expected.documents[0],
    id: f.value.save.commandID,
    ordinal: 2,
    description: f.value.save.description,
  });
  const snapshot = () => {
    const value = {
      readOnly: "on",
      database: "factory",
      schema: f.expected.schemaDigest,
      busy: Object.fromEntries(Object.keys(idleRules).map((key) => [key, 0])),
      history: clone(f.expected.history),
      project: clone(f.expected.project),
      ticket: {
        ...f.expected.ticket,
        ...(saved
          ? { description: f.value.save.description, version: f.expected.ticket.version + 1 }
          : {}),
      },
      documents: saved ? [newDoc(), ...clone(f.expected.documents)] : clone(f.expected.documents),
      requirements: clone(f.expected.requirements),
      scope: f.expected.requirementRevisionID,
      source: { eligible: true, sha256: f.expected.source.leaseSHA256 },
      account: clone(f.value.account),
      sessions: authenticated ? ["new-session"] : [],
      saved: saved
        ? {
            id: f.value.save.commandID,
            ticketID: f.expected.ticket.id,
            createdBy: f.value.account.id,
            authorKind: "human",
            proposalEntryID: null,
          }
        : null,
    };
    dbHook?.(value);
    return value;
  };
  const command: Command = async (args, input) => {
    calls.push({ args, input });
    expect(args.slice(0, 4)).toEqual(["kubectl", "--kubeconfig", f.value.kubeconfig, "--context"]);
    const ctx = args[4],
      operation = args[7];
    if (operation === "get") {
      const kind = args[8];
      const key =
        kind === "endpointslices"
          ? (args[args.indexOf("--selector") + 1] ?? "").split("=")[1]
          : args[9];
      const value = objects.get(`${ctx}/${kind}/${key}`);
      if (!value) throw Error(`Unrecorded unit command ${ctx}/${kind}/${key}`);
      return { code: 0, stdout: JSON.stringify(value) };
    }
    expect(ctx).toBe(to);
    expect(operation).toBe("exec");
    if (args.includes("psql")) {
      expect(args).toContain(f.value.target.postgresPod.name);
      expect(input).toBe(
        applicationSQL({ ...f.value, expected: f.expected } as Parameters<
          typeof applicationSQL
        >[0]),
      );
      return { code: 0, stdout: JSON.stringify(snapshot()) };
    }
    expect(args).toContain(f.value.target.applicationPod.name);
    expect(args).toContain("bun");
    return {
      code: 0,
      stdout: JSON.stringify({
        treeSHA256: f.build.treeSHA256,
        functions: clone(f.build.functions),
        environmentHashes: Object.fromEntries(
          Object.entries({
            FACTORY_BASE_URL: f.backup.source.factoryOrigin,
            FACTORY_FORGEJO_PUBLIC_URL: f.backup.source.forgejoOrigin,
            FACTORY_FORGEJO_API_URL: `http://factory-forgejo.${ns}.svc:3000/api/v1/`,
            FACTORY_HELM_RELEASE: "factory",
            FACTORY_STATE_DIRECTORY: "/var/lib/factory",
            FACTORY_AUTH_SECRET: f.secrets["auth-secret"] ?? "",
            FACTORY_ADMIN_PASSWORD: f.secrets["admin-password"] ?? "",
            FACTORY_DATABASE_PASSWORD: f.secrets["database-password"] ?? "",
            FACTORY_WIKI_WEBHOOK_SECRET: f.secrets["webhook-secret"] ?? "",
            DATABASE_URL: `postgresql://factory:${f.secrets["database-password"]}@factory-postgres.${ns}.svc:5432/factory`,
          }).map(([key, value]) => [key, hash(value)]),
        ),
        startupID: uid(40),
        installation: {
          runtime: "substrate",
          namespace: ns,
          release: "factory",
          factoryURL: f.backup.source.factoryOrigin,
          forgeURL: f.backup.source.forgejoOrigin,
          storageClass: "retained-storage",
        },
      }),
    };
  };
  const wire: Wire = {
    serialize: async (args) => JSON.stringify([{ method: "POST", data: args }]),
    decode: async (r) => ((await r.json()) as { result: unknown }).result,
  };
  const http = async (request: HTTPRequest) => {
    requests.push(request);
    expect(request.address).toBe(f.value.target.address);
    expect(request.ca).not.toContain("PRIVATE KEY");
    const override = httpHook?.(request);
    if (override) return override;
    const url = new URL(request.url),
      path = url.pathname;
    const forge = url.origin === f.backup.source.forgejoOrigin;
    if (forge) {
      expect(request.method).toBe("GET");
      expect(request.headers["cookie"]).toBeUndefined();
      expect(request.headers["authorization"]).toBe("Bearer private-restored-forge-token-123456");
      if (path.includes("/git/commits/")) return response({ sha: f.expected.git.commit });
      expect(url.searchParams.get("ref")).toBe(f.expected.git.commit);
      return response({
        type: "file",
        path: f.expected.git.path,
        sha: f.expected.git.blob,
        content: Buffer.from("Git").toString("base64"),
        encoding: "base64",
        size: 3,
      });
    }
    expect(url.origin).toBe(f.backup.source.factoryOrigin);
    expect(request.headers["authorization"]).toBeUndefined();
    if (path === "/health/ready")
      return response(
        { ready: true },
        { "x-open-factory": "ready", "x-open-factory-startup": uid(40) },
      );
    if (path === "/api/auth/sign-in/email") {
      expect(JSON.parse(request.body ?? "").password).toBe("private-restored-password");
      authenticated = true;
      return response(
        { user: f.value.account },
        {
          "set-cookie": [
            "__Secure-owned.session_token=private-session-token; Path=/; Secure; HttpOnly; SameSite=Lax",
          ],
        },
      );
    }
    if (path === "/api/auth/sign-out") {
      authenticated = false;
      return response(
        { success: true },
        { "set-cookie": ["__Secure-owned.session_token=; Path=/; Secure; HttpOnly; Max-Age=0"] },
      );
    }
    expect(request.headers["cookie"]).toBe("__Secure-owned.session_token=private-session-token");
    if (path === "/api/auth/get-session") return response({ user: f.value.account });
    if (path.includes("/source/read")) {
      expect(JSON.parse(request.body ?? "")).toEqual({ path: f.expected.source.path });
      return response({
        kind: "file",
        size: 6,
        content: Buffer.from("Source").toString("base64"),
        version: "restored-source-cas",
      });
    }
    expect(request.headers["x-server-function-format"]).toBe("0");
    expect(request.headers["content-type"]).toBe("text/plain");
    const args = JSON.parse(request.body ?? "")[0].data;
    const id = path.split("/").at(-1);
    if (id === f.build.functions.getBootstrap)
      return response({
        result: {
          ok: true,
          value: {
            session: { user: f.value.account, systemManager: false },
            zeroCacheURL: `${f.backup.source.factoryOrigin}/zero`,
            planningCacheScope: "a".repeat(64),
          },
        },
      });
    if (id === f.build.functions.saveTicketDocument) {
      expect(saved).toBe(false);
      expect(args[0]).toBe(f.expected.ticket.id);
      expect(args[1]).toEqual({
        commandId: f.value.save.commandID,
        expectedVersion: 7,
        expectedDocumentId: uid(33),
        requirementRevisionId: f.expected.requirementRevisionID,
        title: f.expected.ticket.title,
        description: f.value.save.description,
        requirement: JSON.parse(f.expected.documents[0]?.canonicalContent ?? "null"),
      });
      saved = true;
      return response({
        result: {
          ok: true,
          value: {
            id: f.value.save.commandID,
            ticketVersion: 8,
            requirementRevisionId: f.expected.requirementRevisionID,
          },
        },
      });
    }
    expect(id).toBe(f.build.functions.getTicketDetail);
    const value = snapshot();
    return response({
      result: {
        ok: true,
        value: {
          ticket: value.ticket,
          documentRevisions: value.documents,
          revisions: value.requirements,
        },
      },
    });
  };
  return {
    objects,
    calls,
    requests,
    command,
    http,
    wire,
    projects: async () => [clone(f.expected.project)],
    snapshot,
    dbHook: (next: typeof dbHook) => {
      dbHook = next;
    },
    httpHook: (next: typeof httpHook) => {
      httpHook = next;
    },
    saveCalls: () => requests.filter((r) => r.url.endsWith(f.build.functions.saveTicketDocument)),
  };
}

test("the already-restored application proof performs one fenced save, reads exact Git and independent Source, logs out and keeps credentials out of evidence", async () => {
  const f = await fixture();
  try {
    const fake = target(f),
      result = await checkRestoredApplication(await f.load(), fake);
    expect(result.status).toBe("restored-application-passed");
    expect(result.save).toBe("confirmed");
    expect(result.logout).toBe("confirmed");
    expect(result.projectRead).toBe("complete");
    expect(result.oldActors).toBe("not-run-not-qualified");
    expect(result.newCompute).toBe("not-run-not-qualified");
    expect(fake.saveCalls()).toHaveLength(1);
    expect(fake.calls.every(({ args }) => ["get", "exec"].includes(args[7] ?? ""))).toBe(true);
    expect(
      fake.calls
        .filter((c) => c.args[7] === "exec")
        .every((c) => c.args.includes("psql") || c.args.includes("bun")),
    ).toBe(true);
    expect(fake.requests.filter((r) => r.url.includes("/source/read"))).toHaveLength(2);
    expect(fake.requests.map((r) => [r.method, new URL(r.url).pathname])).toEqual([
      ["GET", "/health/ready"],
      ["POST", "/api/auth/sign-in/email"],
      ["GET", "/api/auth/get-session"],
      ["POST", "/_server/data/opaque-bootstrap"],
      ["POST", "/_server/data/opaque-ticket"],
      ["GET", `/api/v1/repos/owned/retained/git/commits/${f.expected.git.commit}`],
      ["GET", "/api/v1/repos/owned/retained/contents/README.md"],
      ["POST", `/api/workspaces/${f.expected.source.workspaceID}/source/read`],
      ["POST", "/_server/data/opaque-save"],
      ["POST", "/_server/data/opaque-ticket"],
      ["POST", `/api/workspaces/${f.expected.source.workspaceID}/source/read`],
      ["POST", "/api/auth/sign-out"],
    ]);
    const receipt = await readFile(join(f.value.evidenceDirectory, "result.json"), "utf8");
    for (const secret of [
      "private-restored-password",
      "private-restored-forge-token",
      "private-session-token",
      "Original human text",
      "Source",
    ])
      expect(receipt).not.toContain(secret);
    for (const r of fake.requests)
      expect(r.url).not.toMatch(
        /implement|Runtime|Compute|Delivery|startWorkspace|native|model|interview/i,
      );
  } finally {
    await f.close();
  }
});

function admitServiceAccount(fake: ReturnType<typeof target>, f: Fixture) {
  const to = f.value.target.context;
  const template = fake.objects.get(`${to}/deployment/factory`).spec.template.spec;
  const pod = fake.objects.get(`${to}/pod/factory-pod`).spec;
  template.serviceAccountName = "factory";
  pod.serviceAccountName = "factory";
  const name = "kube-api-access-a1b2c";
  pod.containers[0].volumeMounts = [
    {
      name,
      mountPath: "/var/run/secrets/kubernetes.io/serviceaccount",
      readOnly: true,
    },
  ];
  const serviceAccountToken = { expirationSeconds: 3607, path: "token" };
  const credentialSource = { serviceAccountToken };
  const configMap = { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] };
  const namespaceField = { apiVersion: "v1", fieldPath: "metadata.namespace" };
  const volume = {
    name,
    projected: {
      defaultMode: 420,
      sources: [
        credentialSource,
        { configMap },
        {
          downwardAPI: {
            items: [
              {
                path: "namespace",
                fieldRef: namespaceField,
              },
            ],
          },
        },
      ],
    },
  };
  pod.volumes = [volume];
  return {
    template,
    pod,
    volume,
    serviceAccountToken,
    credentialSource,
    configMap,
    namespaceField,
  };
}

test("the restored application admits only Kubernetes' exact standard ServiceAccount projection without changing its execution template", async () => {
  const f = await fixture();
  try {
    const fake = target(f);
    admitServiceAccount(fake, f);
    const result = await checkRestoredApplication(await f.load(), fake);
    expect(result.status).toBe("restored-application-passed");
    expect(fake.saveCalls()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test.each([
  "account",
  "automount disabled",
  "writable",
  "subpath",
  "extra mount",
  "missing volume",
  "secret source",
  "audience",
  "token lifetime",
  "token path",
  "CA",
  "namespace",
  "extra source",
] as const)(
  "the restored application refuses a changed admitted credential projection: %s",
  async (boundary) => {
    const f = await fixture();
    try {
      const fake = target(f);
      const {
        template,
        pod,
        volume,
        serviceAccountToken,
        credentialSource,
        configMap,
        namespaceField,
      } = admitServiceAccount(fake, f);
      const mount = pod.containers[0].volumeMounts[0];
      if (boundary === "account") pod.serviceAccountName = "different";
      if (boundary === "automount disabled") template.automountServiceAccountToken = false;
      if (boundary === "writable") mount.readOnly = false;
      if (boundary === "subpath") mount.subPath = "token";
      if (boundary === "extra mount")
        pod.containers[0].volumeMounts.push({ name: "other", mountPath: "/other" });
      if (boundary === "missing volume") pod.volumes = [];
      if (boundary === "secret source")
        Object.assign(credentialSource, { secret: { name: "other" } });
      if (boundary === "audience") Object.assign(serviceAccountToken, { audience: "other" });
      if (boundary === "token lifetime") serviceAccountToken.expirationSeconds = 86400;
      if (boundary === "token path") serviceAccountToken.path = "other";
      if (boundary === "CA") configMap.name = "other";
      if (boundary === "namespace") namespaceField.fieldPath = "metadata.name";
      if (boundary === "extra source")
        volume.projected.sources.push({ configMap: { name: "other", items: [] } });
      const result = await checkRestoredApplication(await f.load(), fake);
      expect(result.status).toBe("incomplete");
      expect(fake.requests).toHaveLength(0);
      expect(fake.saveCalls()).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
);

test.each([
  "https://git.example.invalid/owned/retained",
  "http://factory-forgejo.factory.svc:3000/owned/retained",
  "http://factory-forgejo.factory.svc:3000/owned/retained.git",
])("restore preserves a supported original repository URL: %s", async (repositoryUrl) => {
  const f = await fixture();
  try {
    f.expected.project.repositoryUrl = repositoryUrl;
    await f.save();
    const fake = target(f);
    const result = await checkRestoredApplication(await f.load(), fake);
    expect(result.status).toBe("restored-application-passed");
    const gitRequests = fake.requests.filter((r) => r.url.includes("/api/v1/repos/"));
    expect(gitRequests).toHaveLength(2);
    expect(gitRequests.every((r) => r.url.startsWith(f.backup.source.forgejoOrigin))).toBe(true);
    expect(f.expected.project.repositoryUrl).toBe(repositoryUrl);
  } finally {
    await f.close();
  }
});

test.each([
  "http://factory-forgejo.other.svc:3000/owned/retained",
  "http://other-forgejo.factory.svc:3000/owned/retained",
  "http://factory-forgejo.factory.svc:3001/owned/retained",
  "http://factory-forgejo.factory.svc:3000/owned/wrong",
  "https://git.example.invalid/other/retained",
  "https://git.example.invalid/owned/retained?token=private",
  "https://user:private@git.example.invalid/owned/retained",
  "https://git.example.invalid/owned/ignored/../retained",
])(
  "restore refuses a repository URL outside its original Forge identity: %s",
  async (repositoryUrl) => {
    const f = await fixture();
    try {
      f.expected.project.repositoryUrl = repositoryUrl;
      await f.save();
      await expect(f.load()).rejects.toThrow();
    } finally {
      await f.close();
    }
  },
);

test("an unchanged complete requirement keeps its existing scope and historical revisions", async () => {
  const f = await fixture();
  try {
    const canonicalContent = JSON.stringify({
      acceptanceCriteria: ["Owned acceptance"],
      nonGoals: [],
      summary: "Retained scope",
    });
    f.expected.ticket.state = "ready";
    f.expected.requirementRevisionID = uid(36);
    f.expected.requirements = [
      { id: uid(36), ordinal: 1, canonicalContent, contentDigest: hash(canonicalContent) },
    ];
    Object.assign(f.expected.documents[0] ?? {}, {
      canonicalContent,
      contentDigest: hash(canonicalContent),
      requirementRevisionId: uid(36),
    });
    await f.save();
    const fake = target(f);
    const result = await checkRestoredApplication(await f.load(), fake);
    expect(result.status).toBe("restored-application-passed");
    expect(fake.saveCalls()).toHaveLength(1);
    expect(JSON.parse(fake.saveCalls()[0]?.body ?? "")[0].data[1]).not.toHaveProperty(
      "proposalEntryId",
    );
  } finally {
    await f.close();
  }
});

test("finalized submission history is not pending external work", () => {
  expect(historyBusy("workspace_submission", historyRows())).toBe(0);
});

test("settled historical unknown probe usage retains its outcome without becoming pending", () => {
  expect(historyBusy("usage_operation", historyRows())).toBe(0);
});

test("the loader requires independent finalized-operation history instead of silently omitting it", async () => {
  const f = await fixture();
  try {
    for (const table of finalizedHistory) delete f.expected.history[table];
    await f.save();
    await expect(f.load()).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("the loader refuses the old witness without finalized workflow and retry history", async () => {
  const f = await fixture();
  try {
    for (const table of workflowHistory) delete f.expected.history[table];
    await f.save();
    await expect(f.load()).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test.each(workflowHistory)(
  "independent workflow history requires %s even when empty",
  async (table) => {
    const f = await fixture();
    try {
      await f.load();
      delete f.expected.history[table];
      await f.save();
      await expect(f.load()).rejects.toThrow();
    } finally {
      await f.close();
    }
  },
);

for (const stage of ["startup", "save", "logout"] as const)
  test.each(workflowHistory)(
    `${stage} cannot hide a rewritten finalized %s outcome or decision`,
    async (table) => {
      const f = await fixture();
      try {
        const loaded = await f.load();
        const sql = applicationSQL(loaded);
        const fake = target(f);
        let loggedOut = false;
        fake.httpHook((request) => {
          if (request.url.endsWith("/sign-out")) loggedOut = true;
          return undefined;
        });
        fake.dbHook((value) => {
          const changed = stage === "startup" || (stage === "save" ? value.saved : loggedOut);
          // A DB row rewrite is observable only if the real SQL selects that table.
          // This catches the old omission, not just comparison of a fabricated extra key.
          if (changed && sql.includes(`SELECT to_jsonb(t) FROM factory.${table} t`))
            value.history[table] = {
              ...value.history[table],
              sha256: hash("rewritten original workflow row"),
            };
        });
        const result = await checkRestoredApplication(loaded, fake);
        expect(result.status).toBe("incomplete");
        if (stage === "startup") expect(fake.requests).toHaveLength(0);
        else {
          expect(fake.saveCalls()).toHaveLength(1);
          expect(result.save).toBe("confirmed");
          expect(result.logout).toBe("confirmed");
        }
      } finally {
        await f.close();
      }
    },
  );

test.each([
  "workspace has no changes to commit",
  "workspace HEAD no longer matches the commit intent",
  "an ordinary commit cannot accept an unadmitted merge",
])("only a recorded definite pre-push failure is finalized submission history: %s", (error) => {
  const rows = historyRows();
  Object.assign(historyRow(rows.change_commit_operation), {
    state: "failed",
    commit_sha: null,
    observed_remote_sha: null,
    last_error: error,
  });
  expect(historyBusy("workspace_submission", rows)).toBe(0);
});

test.each(["commit-intended", "commit-uncertain", "committed", "push-intended", "push-uncertain"])(
  "submission history still refuses %s even with a claimed completion timestamp",
  (state) => {
    const rows = historyRows();
    historyRow(rows.change_commit_operation).state = state;
    expect(historyBusy("workspace_submission", rows)).toBe(1);
  },
);

test.each([
  "missing operation",
  "missing completion",
  "missing prepare",
  "missing commit",
  "unconfirmed push",
  "wrong actor",
  "wrong workspace",
  "wrong change",
  "wrong attempt",
  "wrong source",
  "wrong request",
  "failed after commit",
  "unclassified failure",
  "uncertain push error",
  "missing state",
  "success with error",
  "unprepared failure",
] as const)("submission finality refuses %s", (boundary) => {
  const rows = historyRows(),
    op = historyRow(rows.change_commit_operation);
  if (boundary === "missing operation") rows.change_commit_operation = [];
  if (boundary === "missing completion") Object.assign(op, { completed_at: null });
  if (boundary === "missing prepare")
    Object.assign(historyRow(rows.workspace_submission), { prepare_attempted_at: null });
  if (boundary === "missing commit")
    Object.assign(op, { commit_sha: null, observed_remote_sha: null });
  if (boundary === "unconfirmed push") op.observed_remote_sha = "b".repeat(40);
  if (boundary === "wrong actor") op.created_by = uid(99);
  if (boundary === "wrong workspace") historyRow(rows.runtime_attempt).workspace_id = uid(99);
  if (boundary === "wrong change") historyRow(rows.development_workspace).change_id = uid(99);
  if (boundary === "wrong attempt") op.runtime_attempt_id = uid(99);
  if (boundary === "wrong source") op.source = "agent";
  if (boundary === "wrong request") op.idempotency_key = `workspace:${uid(99)}`;
  if (boundary === "failed after commit")
    Object.assign(op, { state: "failed", last_error: "workspace has no changes to commit" });
  if (boundary === "unclassified failure" || boundary === "uncertain push error")
    Object.assign(op, {
      state: "failed",
      commit_sha: null,
      observed_remote_sha: null,
      last_error: boundary === "uncertain push error" ? "push response lost" : "another failure",
    });
  if (boundary === "missing state") Object.assign(op, { state: null });
  if (boundary === "success with error") op.last_error = "unresolved observation";
  if (boundary === "unprepared failure") {
    Object.assign(op, {
      state: "failed",
      commit_sha: null,
      observed_remote_sha: null,
      last_error: "workspace has no changes to commit",
    });
    Object.assign(historyRow(rows.workspace_submission), { prepare_attempted_at: null });
  }
  expect(historyBusy("workspace_submission", rows)).toBe(1);
});

test.each(["planning", "build"])(
  "a finalized %s probe keeps historical unknown accounting unchanged",
  (role) => {
    const rows = historyRows();
    historyRow(rows.model_role_probe).role = role;
    historyRow(rows.model_role_probe).state = "finished";
    historyRow(rows.usage_operation).engine = role === "build" ? "opencode" : "mastra";
    const before = JSON.stringify(rows);
    expect(historyBusy("usage_operation", rows)).toBe(0);
    expect(JSON.stringify(rows)).toBe(before);
  },
);

test.each([
  "unsettled",
  "missing outcome",
  "unsupported outcome",
  "missing probe",
  "probing owner",
  "unfinished probe",
  "missing result",
  "wrong request",
  "wrong user",
  "wrong model",
  "wrong engine",
  "probe project",
  "Coding unknown",
  "learning unknown",
  "orphan unknown",
  "missing gap entry",
  "wrong gap owner",
  "gap outcome overwritten",
] as const)("historical unknown usage refuses %s", (boundary) => {
  const rows = historyRows(),
    usage = historyRow(rows.usage_operation),
    probe = historyRow(rows.model_role_probe);
  if (boundary === "unsettled") Object.assign(usage, { settled_at: null });
  if (boundary === "missing outcome") Object.assign(usage, { outcome: null });
  if (boundary === "unsupported outcome") usage.outcome = "pending";
  if (boundary === "missing probe") rows.model_role_probe = [];
  if (boundary === "probing owner") probe.state = "probing";
  if (boundary === "unfinished probe") Object.assign(probe, { finished_at: null });
  if (boundary === "missing result") Object.assign(probe, { result: null });
  if (boundary === "wrong request") usage.id = `probe:${uid(99)}`;
  if (boundary === "wrong user") usage.user_id = uid(99);
  if (boundary === "wrong model") usage.model = "different-model";
  if (boundary === "wrong engine") usage.engine = "opencode";
  if (boundary === "probe project") usage.project_id = uid(31);
  if (boundary === "Coding unknown")
    Object.assign(usage, { id: `turn:${uid(64)}`, purpose: "coding", engine: "opencode" });
  if (boundary === "learning unknown") usage.purpose = "learning";
  if (boundary === "orphan unknown")
    Object.assign(usage, { id: `orphan:${uid(64)}`, purpose: "research" });
  if (boundary === "missing gap entry") rows.usage_entry = [];
  if (boundary === "wrong gap owner")
    historyRow(rows.usage_entry).operation_id = `probe:${uid(99)}`;
  if (boundary === "gap outcome overwritten") historyRow(rows.usage_entry).outcome = "completed";
  expect(historyBusy("usage_operation", rows)).toBe(1);
});

test.each(["succeeded", "failed"])(
  "a finalized %s Wiki retains old unknown usage alongside a successful retry",
  (state) => {
    const rows = historyRows();
    Object.assign(historyRow(rows.usage_operation), {
      id: `wiki:${uid(65)}:${uid(66)}:call-1`,
      purpose: "wiki",
      project_id: uid(31),
    });
    historyRow(rows.usage_entry).operation_id = historyRow(rows.usage_operation).id;
    historyRow(rows.knowledge_generation).state = state;
    rows.knowledge_generation.push({
      ...historyRow(rows.knowledge_generation),
      id: uid(99),
      state: "succeeded",
    });
    const before = JSON.stringify(rows);
    expect(historyBusy("usage_operation", rows)).toBe(0);
    expect(JSON.stringify(rows)).toBe(before);
  },
);

test.each([
  "running",
  "pending",
  "missing completion",
  "missing owner",
  "wrong owner",
  "wrong project",
  "wrong user",
  "wrong engine",
  "missing attempt",
  "missing call",
  "different successful retry",
] as const)("historical Wiki unknown usage refuses %s", (boundary) => {
  const rows = historyRows(),
    usage = historyRow(rows.usage_operation),
    generation = historyRow(rows.knowledge_generation);
  Object.assign(usage, {
    id: `wiki:${uid(65)}:${uid(66)}:call-1`,
    purpose: "wiki",
    project_id: uid(31),
  });
  historyRow(rows.usage_entry).operation_id = usage.id;
  if (boundary === "running" || boundary === "pending") generation.state = boundary;
  if (boundary === "missing completion") Object.assign(generation, { completed_at: null });
  if (boundary === "missing owner") rows.knowledge_generation = [];
  if (boundary === "wrong owner") generation.id = uid(99);
  if (boundary === "wrong project") usage.project_id = uid(99);
  if (boundary === "wrong user") usage.user_id = uid(99);
  if (boundary === "wrong engine") usage.engine = "opencode";
  if (boundary === "missing attempt") usage.id = `wiki:${uid(65)}::call-1`;
  if (boundary === "missing call") usage.id = `wiki:${uid(65)}:${uid(66)}:`;
  if (boundary === "different successful retry") {
    generation.state = "running";
    rows.knowledge_generation.push({ ...generation, id: uid(99), state: "succeeded" });
  }
  expect(historyBusy("usage_operation", rows)).toBe(1);
});

test.each(finalizedHistory)(
  "independent history must include %s, even when empty",
  async (table) => {
    const f = await fixture();
    try {
      for (const name of finalizedHistory)
        f.expected.history[name] = { rows: 0, sha256: hash("[]") };
      await f.save();
      await f.load();
      delete f.expected.history[table];
      await f.save();
      await expect(f.load()).rejects.toThrow();
    } finally {
      await f.close();
    }
  },
);

test.each(finalizedHistory)(
  "restored startup cannot rewrite or replay witnessed %s before login",
  async (table) => {
    const f = await fixture();
    try {
      const fake = target(f);
      fake.dbHook((value) => {
        value.history[table].sha256 = hash("overwritten outcome or replayed event");
      });
      const result = await checkRestoredApplication(await f.load(), fake);
      expect(result.status).toBe("incomplete");
      expect(fake.requests).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
);

test.each(finalizedHistory)(
  "the guarded save cannot rewrite or replay witnessed %s",
  async (table) => {
    const f = await fixture();
    try {
      const fake = target(f);
      fake.dbHook((value) => {
        if (value.saved) value.history[table].sha256 = hash("changed after authorized save");
      });
      const result = await checkRestoredApplication(await f.load(), fake);
      expect(result.status).toBe("incomplete");
      expect(fake.saveCalls()).toHaveLength(1);
      expect(result.logout).toBe("confirmed");
    } finally {
      await f.close();
    }
  },
);

test("finalized history does not admit learning trials or drop active operation guards", () => {
  expect(idleRules["learning_trial"]).toBe("true");
  expect(idleRules["change_commit_operation"]).toBe("state::text NOT IN ('succeeded','failed')");
  expect(idleRules["model_role_probe"]).toBe("state = 'probing'");
  expect(idleRules["knowledge_generation"]).toBe("state::text NOT IN ('succeeded','failed')");
  expect(idleRules["substrate_actor_rpc"]).toBe("outcome IS NULL");
  expect(idleRules["substrate_input_stop"]).toBe("completed_at IS NULL");
});

test.each([
  "partial requirement",
  "new requirement revision",
  "state transition",
  "reordered history",
] as const)("private preparation refuses an uncertain save prerequisite: %s", async (boundary) => {
  const f = await fixture();
  try {
    const doc = f.expected.documents[0];
    expect(doc).toBeDefined();
    if (!doc) throw Error("missing fixture document");
    if (boundary === "partial requirement")
      doc.canonicalContent = JSON.stringify({ summary: "", acceptanceCriteria: [], nonGoals: [] });
    if (boundary === "new requirement revision" || boundary === "state transition") {
      doc.canonicalContent = JSON.stringify({
        acceptanceCriteria: ["Old scope"],
        nonGoals: [],
        summary: "Scope",
      });
      if (boundary === "state transition") {
        f.expected.requirementRevisionID = uid(36);
        doc.requirementRevisionId = uid(36);
        f.expected.requirements = [
          {
            id: uid(36),
            ordinal: 1,
            canonicalContent: doc.canonicalContent,
            contentDigest: hash(doc.canonicalContent),
          },
        ];
      }
    }
    if (boundary === "reordered history")
      f.expected.documents.push({ ...doc, id: uid(36), ordinal: 2 });
    doc.contentDigest = hash(doc.canonicalContent);
    await f.save();
    await expect(f.load()).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test.each([
  "same context",
  "same cluster UID",
  "public input",
  "CA key",
  "backup failed",
  "build image",
  "wrong witness binding",
  "unowned input",
  "source traversal",
  "kubeconfig plugin",
  "insecure Kubernetes TLS",
  "Kubernetes proxy",
] as const)("private preparation refuses %s before running any command", async (boundary) => {
  const f = await fixture();
  try {
    if (boundary === "same context") f.value.target.context = f.value.source.context;
    if (boundary === "same cluster UID")
      f.value.target.kubeSystemUID = f.value.source.kubeSystemUID;
    if (boundary === "backup failed") f.backup.status = "incomplete";
    if (boundary === "build image") f.build.image = "factory:latest";
    if (boundary === "wrong witness binding") f.expected.backupWitnessDigest = hash("other backup");
    if (boundary === "source traversal") f.expected.source.path = "../source";
    await f.save();
    if (
      boundary === "kubeconfig plugin" ||
      boundary === "insecure Kubernetes TLS" ||
      boundary === "Kubernetes proxy"
    ) {
      // biome-ignore lint/suspicious/noExplicitAny: Add fields the private kubeconfig schema must reject.
      const kubeconfig: any = clone(f.kubeconfig);
      if (boundary === "kubeconfig plugin")
        kubeconfig.users[0].user.exec = { command: "do-not-execute" };
      if (boundary === "insecure Kubernetes TLS")
        kubeconfig.clusters[0].cluster["insecure-skip-tls-verify"] = true;
      if (boundary === "Kubernetes proxy")
        kubeconfig.clusters[0].cluster["proxy-url"] = "https://retained.example.invalid";
      await writeFile(f.value.kubeconfig, JSON.stringify(kubeconfig));
    }
    if (boundary === "public input") await chmod(f.path, 0o644);
    if (boundary === "CA key")
      await writeFile(f.value.ca, "-----BEGIN CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----", {
        mode: 0o600,
      });
    if (boundary === "unowned input") {
      await rm(f.value.password);
      await symlink(f.value.forgeToken, f.value.password);
    }
    await expect(f.load()).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test.each([
  "source cluster UID",
  "target namespace UID",
  "target deployment UID",
  "ownership label",
  "image",
  "platform image",
  "shared ingress",
  "IPv4-mapped ingress",
  "rewritten route",
  "mirrored credentials",
  "overlapping ingress",
  "foreign endpoint",
  "wrong port",
  "wrong postgres service",
  "wrong database",
  "credential",
  "tree",
  "function mapping",
  "inherited credentials",
  "public origins",
] as const)("target observations refuse %s before HTTP or a save", async (boundary) => {
  const f = await fixture();
  try {
    const fake = target(f),
      to = f.value.target.context;
    const obj = (kind: string, key: string) => fake.objects.get(`${to}/${kind}/${key}`);
    if (boundary === "source cluster UID")
      fake.objects.get(`${f.value.source.context}/namespace/kube-system`).metadata.uid = uid(90);
    if (boundary === "target namespace UID") obj("namespace", "factory").metadata.uid = uid(90);
    if (boundary === "target deployment UID") obj("deployment", "factory").metadata.uid = uid(90);
    if (boundary === "ownership label")
      delete obj("namespace", "factory").metadata.labels[ownerLabel];
    if (boundary === "image")
      obj("deployment", "factory").spec.template.spec.containers[0].image =
        "registry.example/factory:mutable";
    if (boundary === "platform image")
      obj("pod", "factory-pod").status.containerStatuses[0].imageID =
        `image@sha256:${"0".repeat(64)}`;
    if (boundary === "shared ingress")
      obj("ingress", "factory").status.loadBalancer.ingress[0].ip = "192.0.2.10";
    if (boundary === "IPv4-mapped ingress") {
      f.value.target.address = "::ffff:192.0.2.10";
      obj("ingress", "factory").status.loadBalancer.ingress[0].ip = f.value.target.address;
    }
    if (boundary === "rewritten route")
      obj("ingress", "factory").metadata.annotations = {
        "nginx.ingress.kubernetes.io/rewrite-target": "/elsewhere",
      };
    if (boundary === "mirrored credentials")
      obj("ingress", "factory").metadata.annotations = {
        "nginx.ingress.kubernetes.io/mirror-target": "https://retained.example.invalid",
      };
    if (boundary === "overlapping ingress")
      obj("ingresses", "--all-namespaces").items.push({
        metadata: { uid: uid(99) },
        spec: { rules: [{ host: "*.example.invalid" }] },
      });
    if (boundary === "foreign endpoint")
      obj("endpointslices", "factory-factory").items[0].endpoints[0].addresses = ["10.0.0.99"];
    if (boundary === "wrong port")
      obj("service", "factory-factory").spec.ports[0].targetPort = 3001;
    if (boundary === "wrong postgres service")
      obj("service", "factory-postgres").metadata.uid = uid(99);
    if (boundary === "wrong database") {
      for (const c of [
        obj("pod", "factory-pod").spec.containers[0],
        obj("deployment", "factory").spec.template.spec.containers[0],
      ])
        c.env.find((e: { name: string }) => e.name === "DATABASE_URL").value =
          "postgresql://retained-source/factory";
    }
    if (boundary === "credential")
      obj("secret", "restore-credentials").data["auth-secret"] =
        Buffer.from("different").toString("base64");
    if (boundary === "public origins")
      obj("configmap", "factory-config").data.FACTORY_BASE_URL = "https://another.example.invalid";
    const command: Command =
      boundary === "tree" || boundary === "function mapping" || boundary === "inherited credentials"
        ? async (args, input, signal) => {
            const result = await fake.command(args, input, signal);
            if (!args.includes("bun")) return result;
            const observed = JSON.parse(result.stdout);
            if (boundary === "tree") observed.treeSHA256 = hash("other build");
            if (boundary === "inherited credentials")
              observed.environmentHashes.FACTORY_AUTH_SECRET = hash("old environment");
            if (boundary === "function mapping")
              observed.functions.saveTicketDocument = "prohibited-inference";
            return { code: 0, stdout: JSON.stringify(observed) };
          }
        : fake.command;
    await f.save();
    const result = await checkRestoredApplication(await f.load(), { ...fake, command });
    expect(result.status).toBe("incomplete");
    expect(fake.requests).toHaveLength(0);
    expect(fake.saveCalls()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test.each(Object.keys(idleRules))(
  "preflight refuses pending work in %s without login",
  async (table) => {
    const f = await fixture();
    try {
      const fake = target(f);
      fake.dbHook((value) => {
        value.busy[table] = 1;
      });
      const result = await checkRestoredApplication(await f.load(), fake);
      expect(result.status).toBe("incomplete");
      expect(result.stage).toBe("quiescence");
      expect(fake.requests).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
);

test.each([
  "history",
  "source owner",
  "Project",
  "Ticket",
  "document history",
  "requirement history",
  "schema",
  "command already exists",
] as const)("preflight refuses a changed %s witness", async (boundary) => {
  const f = await fixture();
  try {
    const fake = target(f);
    fake.dbHook((value) => {
      if (boundary === "history")
        value.history.substrate_binding.sha256 = hash("rewritten native IDs");
      if (boundary === "source owner") value.source.eligible = false;
      if (boundary === "Project")
        value.project.repositoryUrl = "https://wrong.example.invalid/repo.git";
      if (boundary === "Ticket") value.ticket.version++;
      if (boundary === "document history") value.documents[0].description = "changed";
      if (boundary === "requirement history") value.requirements = [{ id: uid(50) }];
      if (boundary === "schema") value.schema = hash("old schema");
      if (boundary === "command already exists") value.saved = { id: f.value.save.commandID };
    });
    const result = await checkRestoredApplication(await f.load(), fake);
    expect(result.status).toBe("incomplete");
    expect(fake.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test.each([
  "readiness",
  "readiness target",
  "login identity",
  "Git commit",
  "Git bytes",
  "Source bytes",
  "Source size",
  "redirect",
  "lost save",
  "changed old history",
  "changed Source after save",
  "logout",
] as const)("a failed %s cannot pass or repeat the single save", async (boundary) => {
  const f = await fixture();
  try {
    const fake = target(f);
    let sources = 0;
    fake.httpHook((r) => {
      if (boundary === "readiness" && r.url.includes("/health/")) return response({ ready: false });
      if (boundary === "readiness target" && r.url.includes("/health/"))
        return response(
          { ready: true },
          { "x-open-factory": "ready", "x-open-factory-startup": uid(99) },
        );
      if (boundary === "login identity" && r.url.endsWith("/get-session"))
        return response({ user: { ...f.value.account, id: uid(99) } });
      if (boundary === "Git commit" && r.url.includes("/git/commits/"))
        return response({ sha: "0".repeat(40) });
      if (boundary === "Git bytes" && r.url.includes("/contents/"))
        return response({ sha: f.expected.git.blob, content: "Tm8=", size: 3, encoding: "base64" });
      if (boundary === "Source bytes" && r.url.includes("/source/read"))
        return response({ kind: "file", content: "Tm8=", version: "cas" });
      if (boundary === "Source size" && r.url.includes("/source/read"))
        return response({ kind: "file", size: 9, content: "U291cmNl", version: "cas" });
      if (boundary === "redirect" && r.url.includes("/git/"))
        return response({}, { location: "https://retained.example.invalid" }, 302);
      if (boundary === "lost save" && r.url.endsWith("opaque-save"))
        throw Error("private-restored-password sensitive transport error");
      if (boundary === "changed old history" && r.url.endsWith("opaque-save"))
        fake.dbHook((value) => {
          if (value.saved) value.history.change_writer.sha256 = hash("unrelated write");
        });
      if (
        boundary === "changed Source after save" &&
        r.url.includes("/source/read") &&
        ++sources > 1
      )
        return response({ kind: "file", content: "U291cmNl", version: "new-writer" });
      if (boundary === "logout" && r.url.endsWith("/sign-out")) throw Error("uncertain logout");
    });
    const result = await checkRestoredApplication(await f.load(), fake);
    expect(result.status).toBe("incomplete");
    expect(fake.saveCalls().length).toBeLessThanOrEqual(1);
    if (boundary === "lost save") {
      expect(result.save).toBe("unconfirmed");
      expect(fake.saveCalls()).toHaveLength(1);
    }
    if (!["readiness", "readiness target", "logout"].includes(boundary))
      expect(result.logout).toBe("confirmed");
    expect(await readFile(join(f.value.evidenceDirectory, "result.json"), "utf8")).not.toContain(
      "sensitive transport error",
    );
  } finally {
    await f.close();
  }
});

test("the target must remain owned before credentials or logout are sent", async () => {
  const f = await fixture();
  try {
    const fake = target(f);
    fake.httpHook((r) => {
      if (r.url.endsWith("/sign-in/email"))
        fake.objects.get(`${f.value.target.context}/namespace/factory`).metadata.uid = uid(99);
    });
    const result = await checkRestoredApplication(await f.load(), fake);
    expect(result.status).toBe("incomplete");
    expect(result.logout).toBe("unconfirmed");
    expect(fake.requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/health/ready",
      "/api/auth/sign-in/email",
    ]);
  } finally {
    await f.close();
  }
});

test("a save applied before a lost reply remains unconfirmed and is never replayed", async () => {
  const f = await fixture();
  try {
    const fake = target(f);
    const result = await checkRestoredApplication(await f.load(), {
      ...fake,
      http: async (request) => {
        const observed = await fake.http(request);
        if (request.url.endsWith(f.build.functions.saveTicketDocument))
          throw Error("Lost response after commit");
        return observed;
      },
    });
    expect(result.status).toBe("incomplete");
    expect(result.save).toBe("unconfirmed");
    expect(result.logout).toBe("confirmed");
    expect(fake.saveCalls()).toHaveLength(1);
    expect(fake.snapshot().saved?.id).toBe(f.value.save.commandID);
    await expect(f.load()).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test.each(["configuration", "credentials", "cancellation"] as const)(
  "a changed %s stops the journey before the save without redirecting logout",
  async (boundary) => {
    const f = await fixture();
    try {
      const fake = target(f),
        controller = new AbortController();
      fake.httpHook((r) => {
        if (!r.url.endsWith("/get-session")) return;
        if (boundary === "configuration")
          fake.objects.get(
            `${f.value.target.context}/configmap/factory-config`,
          ).data.FACTORY_FORGEJO_API_URL = "https://retained.example.invalid/api/v1/";
        if (boundary === "credentials")
          fake.objects.get(`${f.value.target.context}/secret/restore-credentials`).data[
            "auth-secret"
          ] = Buffer.from("changed").toString("base64");
        if (boundary === "cancellation") controller.abort();
      });
      const result = await checkRestoredApplication(await f.load(), {
        ...fake,
        signal: controller.signal,
      });
      expect(result.status).toBe("incomplete");
      expect(fake.saveCalls()).toHaveLength(0);
      expect(result.logout).toBe(boundary === "cancellation" ? "confirmed" : "unconfirmed");
      expect(fake.requests.filter((r) => r.url.endsWith("/sign-out"))).toHaveLength(
        boundary === "cancellation" ? 1 : 0,
      );
    } finally {
      await f.close();
    }
  },
);

test("the SQL is read-only, scope-bounded and covers original native and requirement history", async () => {
  const f = await fixture();
  try {
    const sql = applicationSQL(await f.load());
    expect(sql).toContain("REPEATABLE READ READ ONLY");
    expect(sql).toContain("current_setting('transaction_read_only')");
    for (const table of historyTables) expect(sql).toContain(`factory.${table}`);
    for (const table of finalizedHistory) {
      expect(historyTables).toContain(table);
      expect(sql).toContain(`SELECT to_jsonb(t) FROM factory.${table} t`);
    }
    for (const table of workflowHistory) {
      expect(historyTables).toContain(table);
      expect(sql).toContain(`SELECT to_jsonb(t) FROM factory.${table} t`);
    }
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CALL|DO)\b/);
    expect(sql).toContain(`id<>'${f.value.save.commandID}'::uuid`);
    const code = `(${applicationBuildTree.toString()})()`;
    const child = Bun.spawn(["node", "--check", "--input-type=module"], {
      stdin: new Blob([code]),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  } finally {
    await f.close();
  }
});

test.each(["missing", "duplicate", "mismatched", "AST-only", "reader rejection"] as const)(
  "a %s completed Zero Project read cannot reach Save and still logs out",
  async (mode) => {
    const f = await fixture();
    try {
      const fake = target(f);
      fake.projects = async () => {
        if (mode === "reader rejection") throw Error("owned-session-must-not-leak");
        if (mode === "missing") return [];
        if (mode === "duplicate") return [f.expected.project, f.expected.project];
        if (mode === "mismatched") return [{ ...f.expected.project, name: "Changed" }];
        return { kind: "QueryResponse", queries: [{ ast: {} }] } as never;
      };
      const result = await checkRestoredApplication(await f.load(), fake);
      expect(result.status).toBe("incomplete");
      expect(result.projectRead).toBe("failed");
      expect(result.save).toBe("not-sent");
      expect(result.logout).toBe("confirmed");
      expect(fake.saveCalls()).toHaveLength(0);
      expect(await readFile(join(f.value.evidenceDirectory, "result.json"), "utf8")).not.toContain(
        "owned-session-must-not-leak",
      );
    } finally {
      await f.close();
    }
  },
);

test.each(["user", "email", "manager", "cache URL", "cache scope"] as const)(
  "a foreign/malformed bootstrap %s is not authority for the Zero client",
  async (mode) => {
    const f = await fixture();
    try {
      const fake = target(f);
      let reads = 0;
      fake.projects = async () => {
        reads++;
        return [f.expected.project];
      };
      fake.httpHook((request) => {
        if (!request.url.endsWith(f.build.functions.getBootstrap)) return;
        const value = {
          session: { user: { ...f.value.account }, systemManager: false as unknown },
          zeroCacheURL: `${f.backup.source.factoryOrigin}/zero`,
          planningCacheScope: "a".repeat(64),
        };
        if (mode === "user") value.session.user.id = uid(99);
        if (mode === "email") value.session.user.email = "foreign@example.invalid";
        if (mode === "manager") value.session.systemManager = "true";
        if (mode === "cache URL") value.zeroCacheURL = "https://foreign.invalid/zero";
        if (mode === "cache scope") value.planningCacheScope = "";
        return response({ result: { ok: true, value } });
      });
      const result = await checkRestoredApplication(await f.load(), fake);
      expect(result.status).toBe("incomplete");
      expect(result.save).toBe("not-sent");
      expect(result.logout).toBe("confirmed");
      expect(reads).toBe(0);
    } finally {
      await f.close();
    }
  },
);

test.each([
  "route",
  "route type",
  "Service UID",
  "Pod UID",
  "endpoint",
  "not ready",
  "image",
  "database",
  "callback",
  "cookies",
  "CRUD",
  "internal endpoint",
] as const)("a changed Zero %s refuses before authentication or Save", async (mode) => {
  const f = await fixture();
  try {
    const fake = target(f),
      context = f.value.target.context;
    const get = (kind: string, name: string) => fake.objects.get(`${context}/${kind}/${name}`);
    const zero = get("pod", f.value.target.zeroPod.name);
    const route = get("ingress", f.value.target.ingress.name).spec.rules[0].http.paths[0];
    if (mode === "route") route.backend.service.name = "foreign-zero";
    if (mode === "route type") route.pathType = "ImplementationSpecific";
    if (mode === "Service UID")
      get("service", f.value.target.zeroService.name).metadata.uid = uid(99);
    if (mode === "Pod UID") zero.metadata.uid = uid(99);
    if (mode === "endpoint")
      get("endpointslices", f.value.target.zeroService.name).items[0].endpoints[0].targetRef.uid =
        uid(99);
    if (mode === "not ready") zero.status.containerStatuses[0].ready = false;
    if (mode === "image") zero.spec.containers[0].image = "foreign:latest";
    const env: { name: string; value: string }[] = zero.spec.containers[0].env;
    const key = {
      database: "ZERO_UPSTREAM_DB",
      callback: "ZERO_QUERY_URL",
      cookies: "ZERO_QUERY_FORWARD_COOKIES",
      CRUD: "ZERO_ENABLE_CRUD_MUTATIONS",
    }[mode as "database"];
    if (key) {
      const variable = env.find((entry) => entry.name === key);
      if (!variable) throw Error("The owned Zero fixture variable is missing");
      variable.value = "foreign";
    }
    if (mode === "internal endpoint")
      get("endpointslices", "factory-internal").items[0].endpoints[0].targetRef.uid = uid(99);
    const result = await checkRestoredApplication(await f.load(), fake);
    expect(result.status).toBe("incomplete");
    expect(result.save).toBe("not-sent");
    expect(fake.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("the stale getProjects manifest is refused rather than silently introspected or invoked", async () => {
  const f = await fixture();
  try {
    Reflect.deleteProperty(f.build.functions, "getBootstrap");
    Object.assign(f.build.functions, { getProjects: "obsolete-stub" });
    await f.save();
    await expect(f.load()).rejects.toThrow("refused");
  } finally {
    await f.close();
  }
});

test.each(["success", "TLS rejection", "redirect", "oversize"] as const)(
  "the real HTTPS adapter pins the IP and preserves public Host/SNI and certificate verification: %s",
  async (boundary) => {
    const url = "https://factory.example.invalid/api/auth/get-session";
    let options: https.RequestOptions & { autoSelectFamily?: boolean } = {};
    const send = ((input: https.RequestOptions, receive: (response: IncomingMessage) => void) => {
      options = input;
      const request = new EventEmitter() as EventEmitter & { end: (body?: string) => void };
      request.end = () => {
        queueMicrotask(() => {
          if (boundary === "TLS rejection") {
            request.emit("error", Error("certificate verification failed"));
            return;
          }
          const response = new EventEmitter() as EventEmitter & {
            statusCode: number;
            headers: object;
            destroy: (error: Error) => void;
          };
          response.statusCode = boundary === "redirect" ? 302 : 200;
          response.headers = {};
          response.destroy = (error) => response.emit("error", error);
          receive(response as unknown as IncomingMessage);
          response.emit("data", Buffer.from(boundary === "oversize" ? "123456789" : "{}"));
          response.emit("end");
        });
      };
      return request;
    }) as typeof https.request;
    const promise = pinnedApplicationRequest(
      {
        url,
        address: "192.0.2.20",
        ca: "public-ca-only",
        method: "GET",
        headers: {},
        limit: 4,
        signal: AbortSignal.timeout(1000),
      },
      send,
    );
    if (boundary === "TLS rejection" || boundary === "oversize")
      await expect(promise).rejects.toThrow();
    else expect((await promise).status).toBe(boundary === "redirect" ? 302 : 200);
    expect(options.hostname).toBe("192.0.2.20");
    expect(options.servername).toBe("factory.example.invalid");
    expect((options.headers as OutgoingHttpHeaders)["host"]).toBe("factory.example.invalid");
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.agent).toBe(false);
    expect(options.autoSelectFamily).toBe(false);
    expect(options.ca).toBe("public-ca-only");
    expect(options.family).toBe(4);
    if (!options.checkServerIdentity) throw Error("Public hostname verification missing");
    expect(
      options.checkServerIdentity("192.0.2.20", {
        subjectaltname: "DNS:factory.example.invalid",
      } as DetailedPeerCertificate),
    ).toBeUndefined();
    expect(
      options.checkServerIdentity("192.0.2.20", {
        subjectaltname: "DNS:retained.example.invalid",
      } as DetailedPeerCertificate),
    ).toBeInstanceOf(Error);
    expect(
      options.checkServerIdentity("192.0.2.20", {
        subjectaltname: "IP Address:192.0.2.20",
      } as DetailedPeerCertificate),
    ).toBeInstanceOf(Error);
  },
);
