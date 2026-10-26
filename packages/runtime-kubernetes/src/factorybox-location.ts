import { z } from "zod";

const uuid = z.string().regex(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);

export function factoryboxLocation(workerID: string) {
  const key = uuid.parse(workerID).replaceAll("-", "");
  return { workerID, namespace: `factory-box-${key}`, podName: "worker" as const };
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
