// Kubernetes ownership, service/endpoint binding, and pod observation for restored application checks.
import {
  ingressAddresses,
  restoredApplicationContainersMatch,
  verifyFactoryContainerEnv,
  verifyIngressIsolation,
  verifyInternalService,
  verifyZeroPodContainer,
} from "./restore-application-k8s-spec";
import { applicationSQL } from "./restore-application-rules";
import {
  backupAnnotation,
  type Command,
  canonical,
  check,
  type Environment,
  equal,
  type Identity,
  ipKey,
  type LoadedApplicationFixture,
  metadata,
  type Named,
  type OwnerReference,
  type Snapshot,
  uuid,
} from "./restore-application-types";

export { restoredApplicationContainersMatch };

type IngressPath = {
  path?: string;
  pathType?: string;
  backend?: { service?: { name?: string; port?: { number?: number } } };
};

export function createClusterObserver(
  f: LoadedApplicationFixture,
  deps: { command: Command; signal: () => AbortSignal; zeroImage: string },
) {
  const original = f.backupReceipt.source;
  const ns = f.target.namespace.name;
  const bindingState: {
    configuration?: string;
    environment?: Record<string, string>;
    zero?: string;
  } = {};

  async function kubectl(context: string, args: string[], input?: string) {
    const current = deps.signal();
    current.throwIfAborted();
    const result = await deps.command(
      [
        "kubectl",
        "--kubeconfig",
        f.kubeconfig,
        "--context",
        context,
        "--request-timeout",
        `${f.limits.seconds}s`,
        ...args,
      ],
      input,
      current,
    );
    current.throwIfAborted();
    check(result.code === 0 && Buffer.byteLength(result.stdout) <= f.limits.responseBytes);
    return result.stdout.trim();
  }

  async function get(context: string, kind: string, resource: string, namespaced = true) {
    const value = JSON.parse(
      await kubectl(context, [
        "get",
        kind,
        resource,
        ...(namespaced ? ["--namespace", ns] : []),
        "-o",
        "json",
      ]),
    );
    check(!namespaced || value.metadata?.namespace === ns);
    return value;
  }

  async function ownedPod(pod: Identity, role: string) {
    const value = await get(f.target.context, "pod", pod.name);
    metadata(value, pod);
    check(
      value.metadata.labels?.["app.kubernetes.io/instance"] === original.release &&
        value.metadata.labels?.["app.kubernetes.io/component"] === role &&
        value.status?.phase === "Running",
    );
    return value;
  }

  async function serviceEndpoint(
    svc: { metadata: Identity; spec: { ports: unknown } },
    pod: Identity,
    port: number,
  ) {
    const value = await get(f.target.context, "pod", pod.name);
    metadata(value, pod);
    const slices = JSON.parse(
      await kubectl(f.target.context, [
        "get",
        "endpointslices",
        "--namespace",
        ns,
        "--selector",
        `kubernetes.io/service-name=${svc.metadata.name}`,
        "-o",
        "json",
      ]),
    );
    check(slices.items?.length === 1);
    const slice = slices.items[0];
    const portName = port === 5432 ? "postgres" : "http";
    check(
      slice.metadata?.namespace === ns &&
        slice.metadata.ownerReferences?.some(
          (r: OwnerReference) => r.controller && r.kind === "Service" && r.uid === svc.metadata.uid,
        ) &&
        slice.endpoints?.length === 1 &&
        equal(slice.ports, [{ name: portName, port, protocol: "TCP" }]) &&
        equal(svc.spec.ports, [{ name: portName, port, targetPort: port, protocol: "TCP" }]),
    );
    const endpoint = slice.endpoints[0];
    check(
      endpoint.conditions?.ready === true &&
        !endpoint.conditions?.terminating &&
        endpoint.targetRef?.kind === "Pod" &&
        endpoint.targetRef.uid === pod.uid &&
        endpoint.targetRef.name === pod.name &&
        endpoint.targetRef.namespace === ns &&
        endpoint.addresses?.length === 1 &&
        ipKey(endpoint.addresses[0]) === ipKey(value.status.podIP),
    );
  }

  async function verifyZeroRoute(paths: IngressPath[]) {
    const zeroRoutes = paths.filter((p) => p.path === "/zero");
    check(
      paths.length === 2 &&
        zeroRoutes.length === 1 &&
        zeroRoutes[0]?.pathType === "Prefix" &&
        zeroRoutes[0].backend?.service?.name === f.target.zeroService.name &&
        zeroRoutes[0].backend?.service?.port?.number === 4848,
    );
    const service = await get(f.target.context, "service", f.target.zeroService.name);
    metadata(service, f.target.zeroService);
    verifyInternalService(service, original.release, "zero", true);
    const zero = await ownedPod(f.target.zeroPod, "zero");
    verifyZeroPodContainer(f, zero, deps.zeroImage);
    const internal = await get(f.target.context, "service", `${original.release}-internal`);
    check(uuid.test(internal.metadata?.uid));
    verifyInternalService(internal, original.release, "factory", true);
    await serviceEndpoint(internal, f.target.applicationPod, 3000);
    const zeroBinding = canonical({
      podUID: zero.metadata.uid,
      pod: zero.spec,
      serviceUID: service.metadata.uid,
      service: service.spec,
      internalUID: internal.metadata.uid,
      internal: internal.spec,
    });
    check(bindingState.zero === undefined || zeroBinding === bindingState.zero);
    bindingState.zero = zeroBinding;
    await serviceEndpoint(service, f.target.zeroPod, 4848);
  }

  async function verifyBinding(app: {
    spec: { containers: { name: string; env: Environment[]; envFrom: unknown }[] };
  }) {
    const config = await get(f.target.context, "configmap", f.target.configuration.name);
    metadata(config, f.target.configuration);
    const secret = await get(f.target.context, "secret", f.target.credentials.name);
    metadata(secret, f.target.credentials);
    const container = app.spec.containers.find((c) => c.name === "factory");
    const envHashes = verifyFactoryContainerEnv(f, container, config.data, secret.data);
    const pgService = await get(f.target.context, "service", f.target.postgresService.name);
    metadata(pgService, f.target.postgresService);
    verifyInternalService(pgService, original.release, "postgres");
    await serviceEndpoint(pgService, f.target.postgresPod, 5432);
    const observed = canonical({ configuration: config.data, secret: secret.data, pod: app.spec });
    check(bindingState.configuration === undefined || observed === bindingState.configuration);
    bindingState.configuration = observed;
    bindingState.environment = envHashes;
  }

  async function verifyOwnership() {
    const sourceCluster = await get(f.source.context, "namespace", "kube-system", false);
    const targetCluster = await get(f.target.context, "namespace", "kube-system", false);
    metadata(sourceCluster, { name: "kube-system", uid: f.source.kubeSystemUID });
    metadata(targetCluster, { name: "kube-system", uid: f.target.kubeSystemUID });
    check(sourceCluster.metadata.uid !== targetCluster.metadata.uid);
    metadata(await get(f.source.context, "namespace", ns, false), {
      name: ns,
      uid: original.namespaceUID,
    });
    metadata(await get(f.target.context, "namespace", ns, false), f.target.namespace, f.owner);
    const deployment = await get(f.target.context, "deployment", f.target.deployment.name);
    metadata(deployment, f.target.deployment, f.owner);
    check(
      deployment.metadata.annotations?.[backupAnnotation] === f.backup.sha256 &&
        deployment.spec.replicas === 1 &&
        deployment.status?.observedGeneration === deployment.metadata.generation &&
        deployment.status.readyReplicas === 1 &&
        deployment.status.updatedReplicas === 1,
    );
    const container = deployment.spec.template.spec.containers?.find(
      (c: Named) => c.name === "factory",
    );
    check(
      deployment.spec.template.spec.containers.length === 1 &&
        container?.image === f.buildEvidence.image &&
        equal(container.command, [
          "flock",
          "--nonblock",
          "--no-fork",
          "/var/lib/factory/bootstrap.lock",
          "bun",
          "scripts/kubernetes/start.ts",
        ]) &&
        !container.args?.length,
    );
    const app = await get(f.target.context, "pod", f.target.applicationPod.name);
    metadata(app, f.target.applicationPod);
    check(
      app.status?.phase === "Running" &&
        app.spec.containers.find((c: Named) => c.name === "factory")?.image ===
          f.buildEvidence.image &&
        app.status.containerStatuses?.find((c: Named) => c.name === "factory")?.ready === true,
    );
    check(
      app.status.containerStatuses
        .find((c: Named) => c.name === "factory")
        .imageID?.endsWith(`@sha256:${f.buildEvidence.platformDigest}`),
    );
    check(restoredApplicationContainersMatch(deployment.spec.template.spec, app.spec));
    const replica = app.metadata.ownerReferences?.find(
      (r: OwnerReference) => r.controller && r.kind === "ReplicaSet",
    );
    check(replica);
    const rs = await get(f.target.context, "replicaset", replica.name);
    metadata(rs, { name: replica.name, uid: replica.uid });
    check(
      rs.metadata.ownerReferences?.some(
        (r: OwnerReference) =>
          r.controller && r.kind === "Deployment" && r.uid === f.target.deployment.uid,
      ),
    );
    const targetIngress = await get(f.target.context, "ingress", f.target.ingress.name);
    metadata(targetIngress, f.target.ingress, f.owner);
    const sourceIngress = await get(f.source.context, "ingress", f.source.ingress.name);
    metadata(sourceIngress, f.source.ingress);
    const targetAddresses = ingressAddresses(targetIngress),
      sourceAddresses = ingressAddresses(sourceIngress);
    check(
      targetAddresses.includes(ipKey(f.target.address)) &&
        !targetAddresses.some((ip) => sourceAddresses.includes(ip)),
    );
    const ingresses = JSON.parse(
      await kubectl(f.target.context, ["get", "ingresses", "--all-namespaces", "-o", "json"]),
    );
    verifyIngressIsolation(f, targetIngress, ingresses);
    for (const [publicOrigin, service, pod] of [
      [original.factoryOrigin, f.target.factoryService, f.target.applicationPod],
      [original.forgejoOrigin, f.target.forgejoService, f.target.forgejoPod],
    ] as const) {
      const host = new URL(publicOrigin).hostname;
      const rules = targetIngress.spec.rules.filter(
        (rule: { host?: string }) => rule.host === host,
      );
      check(
        rules.length === 1 &&
          targetIngress.spec.tls?.some(
            (tls: { hosts?: string[]; secretName?: string }) =>
              tls.hosts?.includes(host) && tls.secretName,
          ),
      );
      const paths = rules[0].http?.paths;
      check(
        Array.isArray(paths) &&
          paths.filter((p: { path?: string }) => p.path !== "/zero").length === 1,
      );
      const route = paths.find((p: { path?: string }) => p.path === "/");
      check(
        route?.pathType === "Prefix" &&
          route.backend?.service?.name === service.name &&
          route.backend.service.port.number === 3000,
      );
      const svc = await get(f.target.context, "service", service.name);
      metadata(svc, service);
      verifyInternalService(
        svc,
        original.release,
        pod === f.target.applicationPod ? "factory" : "forgejo",
      );
      await serviceEndpoint(svc, pod, 3000);
      if (publicOrigin === original.factoryOrigin) await verifyZeroRoute(paths);
      else check(paths.length === 1);
    }
    await verifyBinding(app);
  }

  async function readDatabaseSnapshot(): Promise<Snapshot> {
    await verifyOwnership();
    await ownedPod(f.target.postgresPod, "postgres");
    return JSON.parse(
      await kubectl(
        f.target.context,
        [
          "exec",
          "--namespace",
          ns,
          f.target.postgresPod.name,
          "--container",
          "postgres",
          "-i",
          "--",
          "psql",
          "-h",
          "/var/run/postgresql",
          "-X",
          "-q",
          "-A",
          "-t",
          "--set",
          "ON_ERROR_STOP=1",
          "-U",
          "factory",
          "-d",
          "factory",
        ],
        applicationSQL(f),
      ),
    );
  }

  return {
    kubectl,
    ownedPod,
    verifyOwnership,
    readDatabaseSnapshot,
    boundEnvironment: () => bindingState.environment,
  };
}
