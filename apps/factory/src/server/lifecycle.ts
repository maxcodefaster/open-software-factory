import type { FactoryApplication } from "./application";
import { createBackgroundJobs } from "./background-jobs";

type LifecycleServices = Pick<
  FactoryApplication,
  | "agentController"
  | "attachmentStore"
  | "developerIDEEdge"
  | "deliveryController"
  | "environmentController"
  | "environmentSecrets"
  | "executionReserve"
  | "idleCompute"
  | "implementationOrders"
  | "knowledgeController"
  | "learningWorker"
  | "mcpConnections"
  | "monitoringWorker"
  | "observeRecoveredRuntimes"
  | "projectPreparation"
  | "projectAgentController"
  | "projectSetup"
  | "releaseController"
  | "reviewMedia"
  | "runtimeAccess"
  | "runtimeController"
  | "wikiSourceUpdates"
  | "accessRevocation"
>;

export function startFactoryLifecycle(application: LifecycleServices) {
  const {
    agentController,
    attachmentStore,
    developerIDEEdge,
    deliveryController,
    environmentController,
    environmentSecrets,
    executionReserve,
    idleCompute,
    implementationOrders,
    knowledgeController,
    learningWorker,
    mcpConnections,
    monitoringWorker,
    observeRecoveredRuntimes,
    projectPreparation,
    projectAgentController,
    projectSetup,
    releaseController,
    reviewMedia,
    runtimeAccess,
    runtimeController,
    wikiSourceUpdates,
  } = application;
  const jobs = createBackgroundJobs();
  observeRecoveredRuntimes();
  const reserveStarted = executionReserve
    .start()
    .catch(() => console.error("Execution reserve startup failed"));
  idleCompute.start();
  jobs.every("Delivery observation failed", () => deliveryController.sweep(), 1_000, true);
  jobs.every("Input observation failed", () => monitoringWorker.sweep(), 2_000, true);
  jobs.every(
    "Factorybox storage reconciliation failed",
    () => runtimeController.reclaimStorage(),
    15_000,
  );
  jobs.every("Release observation is unavailable", () => releaseController.recover(), 5_000);
  jobs.every("Runtime access refresh failed", () => runtimeAccess.sweep(), 60_000);
  jobs.every(
    "Environment secret store renewal failed",
    async () => environmentSecrets.renew?.(),
    60 * 60_000,
  );
  jobs.every(
    "Environment save recovery failed",
    () => environmentController.recover(),
    60 * 60_000,
  );
  jobs.every("Editor access refresh failed", () => developerIDEEdge.sweep(), 30_000);
  // Observe admitted creates. Never repeat an unconfirmed external repository write.
  jobs.every("Project setup observation is unavailable", () => projectSetup.recover(), 15_000);
  jobs.every(
    "Compute wait reconciliation failed",
    () => runtimeController.drainComputeWaits(),
    2_000,
  );
  jobs.every(
    "Retained Build admission failed",
    async () => agentController?.dispatchReadyPending(),
    2_000,
  );
  jobs.every(
    "Wiki reconciliation failed",
    () => knowledgeController.reconcile(),
    15 * 60_000,
    true,
  );
  jobs.every("Work review is unavailable", () => learningWorker.sweep(), 60_000, true);
  jobs.every("Review media retention is unavailable", () => reviewMedia.sweep(), 60_000, true);
  jobs.every("Attachment cleanup is unavailable", () => attachmentStore.sweep(), 60_000, true);
  jobs.every(
    "Wiki hook reconciliation failed",
    () => wikiSourceUpdates.repair(),
    15 * 60_000,
    true,
  );
  jobs.every("Wiki event admission failed", () => wikiSourceUpdates.drain(), 2_000);
  jobs.every("Project image preparation needs retry", () => projectPreparation.drain(), 2_000);
  jobs.every("MCP credential recovery is unavailable", () => mcpConnections.recover(), 30_000);
  jobs.every(
    "Implementation order observation failed",
    () => implementationOrders.reconcile(),
    1_000,
  );
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= (async () => {
      // Stop admitting ticks synchronously, then abort and join owned work.
      // An irreversible Delivery already in flight is observed, never replayed.
      await Promise.all([
        jobs.close(),
        monitoringWorker.close(),
        deliveryController.close(),
        learningWorker.close(),
        projectAgentController.shutdown(),
        knowledgeController.close(),
      ]);
      await reserveStarted;
      await Promise.all([
        executionReserve.close(),
        idleCompute.close(),
        application.accessRevocation.close(),
        agentController?.shutdown(),
      ]);
    })();
    return closing;
  };
}
