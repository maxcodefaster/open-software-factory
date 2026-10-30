import { z } from "zod";

const uuid = z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);

export function factoryboxLocation(workerID: string, admissionID = workerID) {
  const key = uuid.parse(workerID).replaceAll("-", "");
  const admission = uuid.parse(admissionID);
  return {
    workerID,
    namespace: `factory-box-${key}`,
    podName: admission === workerID ? "worker" : `worker-${admission.replaceAll("-", "")}`,
  };
}

export function factoryboxAdmissionID(workerID: string, podName: string) {
  uuid.parse(workerID);
  if (podName === "worker") return workerID;
  const key = /^worker-([a-f0-9]{32})$/.exec(podName)?.[1];
  if (!key) throw new Error("Worker Pod does not identify a canonical admission");
  const admission = uuid.parse(
    `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20)}`,
  );
  if (admission === workerID)
    throw new Error("The original worker admission must retain its original Pod name");
  return admission;
}

export function factoryboxSharedLabels(workerID: string) {
  const { workerID: owner } = factoryboxLocation(workerID);
  return {
    "app.kubernetes.io/managed-by": "open-software-factory",
    "factory.dev/runtime-owner": owner,
    "factory.dev/factorybox-worker": owner,
    "factory.dev/shared-resource": "true",
  };
}

export function factoryboxAssignmentSecret(executionID: string) {
  return `assignment-${uuid.parse(executionID).replaceAll("-", "")}`;
}
