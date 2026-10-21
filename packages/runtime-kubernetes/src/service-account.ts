import { isIP } from "node:net";

// Explicitly select the projected ServiceAccount, rather than relying on a
// workstation-oriented kubectl loader's fallback to localhost:8080. tokenFile
// retains Kubernetes token rotation; no token is copied into this configuration.
export function serviceAccountConfiguration(env: Record<string, string | undefined> = process.env) {
  const host = env["KUBERNETES_SERVICE_HOST"];
  const port = env["KUBERNETES_SERVICE_PORT"];
  if (
    !host ||
    !isIP(host) ||
    !port ||
    !/^[0-9]+$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535
  )
    throw new Error("Kubernetes must supply its in-cluster API address");
  const projected = "/var/run/secrets/kubernetes.io/serviceaccount";
  return {
    apiVersion: "v1",
    kind: "Config",
    clusters: [
      {
        name: "factory",
        cluster: {
          server: `https://${isIP(host) === 6 ? `[${host}]` : host}:${port}`,
          "certificate-authority": `${projected}/ca.crt`,
        },
      },
    ],
    users: [{ name: "factory", user: { tokenFile: `${projected}/token` } }],
    contexts: [{ name: "factory", context: { cluster: "factory", user: "factory" } }],
    "current-context": "factory",
  };
}
