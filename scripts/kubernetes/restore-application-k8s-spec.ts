// Pure Kubernetes container, ingress, service, and secret/config binding checks.
import { isIP } from "node:net";
import {
  base64,
  check,
  digest,
  type Environment,
  equal,
  ipKey,
  type LoadedApplicationFixture,
  type Named,
  object,
} from "./restore-application-types";

export function restoredApplicationContainersMatch(template: unknown, pod: unknown): boolean {
  try {
    object(template);
    object(pod);
    check(
      (pod["serviceAccountName"] ?? "default") === (template["serviceAccountName"] ?? "default"),
    );
    if (equal(template["containers"], pod["containers"])) return true;
    check(
      Array.isArray(template["containers"]) &&
        Array.isArray(pod["containers"]) &&
        template["automountServiceAccountToken"] !== false &&
        pod["automountServiceAccountToken"] !== false &&
        Array.isArray(pod["volumes"]),
    );
    const expectedContainers = template["containers"];
    const podVolumes = pod["volumes"];
    const containers = pod["containers"].map((value, index) => {
      object(value);
      const expected = expectedContainers[index];
      object(expected);
      check(Array.isArray(value["volumeMounts"]));
      const mounts = value["volumeMounts"].filter((entry) => {
        object(entry);
        return entry["mountPath"] === "/var/run/secrets/kubernetes.io/serviceaccount";
      });
      check(mounts.length === 1);
      const mount = mounts[0];
      check(
        /^kube-api-access-[a-z0-9]{5}$/.test(mount.name) &&
          equal(mount, { name: mount.name, mountPath: mount.mountPath, readOnly: true }),
      );
      const volumes = podVolumes.filter((entry) => {
        object(entry);
        return entry["name"] === mount.name;
      });
      check(
        volumes.length === 1 &&
          equal(volumes[0], {
            name: mount.name,
            projected: {
              defaultMode: 420,
              sources: [
                { serviceAccountToken: { expirationSeconds: 3607, path: "token" } },
                {
                  configMap: {
                    name: "kube-root-ca.crt",
                    items: [{ key: "ca.crt", path: "ca.crt" }],
                  },
                },
                {
                  downwardAPI: {
                    items: [
                      {
                        path: "namespace",
                        fieldRef: { apiVersion: "v1", fieldPath: "metadata.namespace" },
                      },
                    ],
                  },
                },
              ],
            },
          }),
      );
      const normalized = {
        ...value,
        volumeMounts: value["volumeMounts"].filter((entry) => entry !== mount),
      };
      if (normalized.volumeMounts.length === 0 && expected["volumeMounts"] === undefined)
        delete (normalized as Record<string, unknown>)["volumeMounts"];
      return normalized;
    });
    // Nothing besides the API server's exact standard credential mount is ignored.
    return equal(containers, expectedContainers);
  } catch {
    return false;
  }
}

export function ingressAddresses(ingress: {
  status?: { loadBalancer?: { ingress?: { ip: string; hostname?: string }[] } };
}): string[] {
  const entries = ingress?.status?.loadBalancer?.ingress;
  check(
    Array.isArray(entries) &&
      entries.length > 0 &&
      entries.every((entry) => isIP(entry.ip) && !entry.hostname),
  );
  return entries.map((entry) => ipKey(entry.ip));
}

export function verifyInternalService(
  svc: {
    spec: {
      type?: string;
      externalName?: string;
      externalIPs?: unknown[];
      selector?: Record<string, string>;
    };
  },
  release: string,
  component: string,
  exactSelector = false,
) {
  const expectedSelector = {
    "app.kubernetes.io/instance": release,
    "app.kubernetes.io/component": component,
  };
  check(
    svc.spec.type !== "ExternalName" &&
      !svc.spec.externalName &&
      !svc.spec.externalIPs?.length &&
      (exactSelector
        ? equal(svc.spec.selector, expectedSelector)
        : svc.spec.selector?.["app.kubernetes.io/instance"] === release &&
          svc.spec.selector?.["app.kubernetes.io/component"] === component),
  );
}

export function verifyIngressIsolation(
  f: LoadedApplicationFixture,
  targetIngress: {
    metadata: { annotations?: Record<string, string> };
    spec: { ingressClassName?: string };
  },
  allIngresses: {
    items?: {
      metadata?: { uid?: string };
      spec?: { defaultBackend?: unknown; rules?: { host?: string }[] };
    }[];
  },
) {
  const original = f.backupReceipt.source;
  const ns = f.target.namespace.name;
  check(
    Array.isArray(allIngresses.items) &&
      allIngresses.items.some((item) => item.metadata?.uid === f.target.ingress.uid),
  );
  for (const item of allIngresses.items) {
    if (item.metadata?.uid === f.target.ingress.uid) continue;
    check(
      !item.spec?.defaultBackend &&
        !item.spec?.rules?.some(
          (rule) =>
            !rule.host ||
            [original.factoryOrigin, original.forgejoOrigin].some((value) => {
              const host = new URL(value).hostname;
              const ruleHost = rule.host?.toLowerCase() ?? "";
              return (
                host === ruleHost || (ruleHost.startsWith("*.") && host.endsWith(ruleHost.slice(1)))
              );
            }),
        ),
    );
  }
  const safeAnnotations: Record<string, string | undefined> = {
    "meta.helm.sh/release-name": original.release,
    "meta.helm.sh/release-namespace": ns,
    "kubernetes.io/ingress.class": targetIngress.spec.ingressClassName,
    "nginx.ingress.kubernetes.io/ssl-redirect": "true",
    "nginx.ingress.kubernetes.io/force-ssl-redirect": "true",
  };
  check(
    !targetIngress.metadata.annotations ||
      Object.entries(targetIngress.metadata.annotations).every(
        ([key, value]) =>
          typeof safeAnnotations[key] === "string" && value === safeAnnotations[key],
      ),
  );
}

export function verifyFactoryContainerEnv(
  f: LoadedApplicationFixture,
  container: { env: Environment[]; envFrom: unknown } | undefined,
  configData: Record<string, string>,
  secretData: Record<string, string>,
): Record<string, string> {
  const original = f.backupReceipt.source;
  const ns = f.target.namespace.name;
  check(
    configData["FACTORY_BASE_URL"] === original.factoryOrigin &&
      configData["FACTORY_FORGEJO_PUBLIC_URL"] === original.forgejoOrigin &&
      configData["FACTORY_HELM_RELEASE"] === original.release &&
      configData["FACTORY_FORGEJO_API_URL"] ===
        `http://${f.target.forgejoService.name}.${ns}.svc:3000/api/v1/`,
  );
  check(
    Object.entries(f.credentialHashes).every(
      ([key, value]) => digest(base64(secretData[key] ?? "")) === value,
    ),
  );
  check(container);
  const env = container.env;
  check(Array.isArray(env) && new Set(env.map((e) => e.name)).size === env.length);
  for (const [key, secretKey] of [
    ["FACTORY_AUTH_SECRET", "auth-secret"],
    ["FACTORY_ADMIN_PASSWORD", "admin-password"],
    ["FACTORY_DATABASE_PASSWORD", "database-password"],
    ["FACTORY_WIKI_WEBHOOK_SECRET", "webhook-secret"],
  ]) {
    check(
      equal(
        env.find((e) => e.name === key),
        {
          name: key,
          valueFrom: { secretKeyRef: { name: f.target.credentials.name, key: secretKey } },
        },
      ),
    );
  }
  check(
    !env.some((e) =>
      ["FACTORY_BASE_URL", "FACTORY_FORGEJO_PUBLIC_URL", "FACTORY_FORGEJO_API_URL"].includes(
        e.name,
      ),
    ),
  );
  check(equal(container.envFrom, [{ configMapRef: { name: f.target.configuration.name } }]));
  check(
    env.find((e) => e.name === "DATABASE_URL")?.value ===
      `postgresql://factory:$(FACTORY_DATABASE_PASSWORD)@${f.target.postgresService.name}.${ns}.svc:5432/factory`,
  );
  const dbPassword = base64(secretData["database-password"] ?? "").toString("utf8");
  return Object.fromEntries(
    Object.entries({
      FACTORY_BASE_URL: original.factoryOrigin,
      FACTORY_FORGEJO_PUBLIC_URL: original.forgejoOrigin,
      FACTORY_FORGEJO_API_URL: `http://${f.target.forgejoService.name}.${ns}.svc:3000/api/v1/`,
      FACTORY_HELM_RELEASE: original.release,
      FACTORY_STATE_DIRECTORY: "/var/lib/factory",
      FACTORY_AUTH_SECRET: base64(secretData["auth-secret"] ?? "").toString("utf8"),
      FACTORY_ADMIN_PASSWORD: base64(secretData["admin-password"] ?? "").toString("utf8"),
      FACTORY_DATABASE_PASSWORD: dbPassword,
      FACTORY_WIKI_WEBHOOK_SECRET: base64(secretData["webhook-secret"] ?? "").toString("utf8"),
      DATABASE_URL: `postgresql://factory:${dbPassword}@${f.target.postgresService.name}.${ns}.svc:5432/factory`,
    }).map(([key, value]) => [key, digest(value)]),
  );
}

export function verifyZeroPodContainer(
  f: LoadedApplicationFixture,
  zero: {
    spec?: {
      containers?: { name: string; image: string; env?: Environment[]; envFrom?: unknown[] }[];
    };
    status: { containerStatuses?: (Named & { ready?: boolean })[] };
  },
  zeroImage: string,
) {
  const original = f.backupReceipt.source;
  const ns = f.target.namespace.name;
  check(
    zero.spec?.containers?.length === 1 &&
      zero.spec.containers[0]?.name === "zero" &&
      zero.spec.containers[0].image === zeroImage &&
      zero.status.containerStatuses?.find((c) => c.name === "zero")?.ready === true,
  );
  const zeroContainer = zero.spec.containers[0];
  const env = zeroContainer.env;
  check(Array.isArray(env) && new Set(env.map((e) => e.name)).size === env.length);
  const observedEnvironment = Object.fromEntries(env.map((e) => [e.name, e.value]));
  for (const key of ["ZERO_UPSTREAM_DB", "ZERO_CVR_DB", "ZERO_CHANGE_DB"])
    check(
      observedEnvironment[key] ===
        `postgresql://factory:$(FACTORY_DATABASE_PASSWORD)@${f.target.postgresService.name}.${ns}.svc:5432/factory`,
    );
  check(
    !zeroContainer.envFrom?.length &&
      equal(
        env.find((e) => e.name === "FACTORY_DATABASE_PASSWORD"),
        {
          name: "FACTORY_DATABASE_PASSWORD",
          valueFrom: {
            secretKeyRef: { name: f.target.credentials.name, key: "database-password" },
          },
        },
      ) &&
      observedEnvironment["ZERO_QUERY_FORWARD_COOKIES"] === "true" &&
      observedEnvironment["ZERO_ENABLE_CRUD_MUTATIONS"] === "false" &&
      observedEnvironment["ZERO_QUERY_URL"] ===
        `http://${original.release}-internal.${ns}.svc:3000/api/zero/query`,
  );
}
