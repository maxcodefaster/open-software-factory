import { drainNativeOperations } from "../runtime/native-lock";
import type { FactoryApplication } from "./application";
import { createBackgroundJobs } from "./background-jobs";

type LifecycleServices = Pick<
  FactoryApplication,
  | "agentController"
  | "attachmentStore"
  | "buildBrowserController"
  | "developerIDEEdge"
  | "deliveryController"
  | "environmentController"
  | "environmentSecrets"
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
  | "setupReadiness"
  | "releaseController"
  | "reviewMedia"
  | "runtimeAccess"
  | "runtimeController"
  | "wikiSourceUpdates"
  | "accessRevocation"
  | "workspaceCommands"
  | "workspaceFiles"
  | "workspaceCollaboration"
  | "workspaceSubmission"
> &
  Partial<Pick<FactoryApplication, "workspaceSources">>;

export function startFactoryLifecycle(
  application: LifecycleServices,
  dispatchReady: () => Promise<boolean> = async () => true,
) {
  const {
    agentController,
    attachmentStore,
    buildBrowserController,
    developerIDEEdge,
    deliveryController,
    environmentController,
    environmentSecrets,
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
  let stopping = false;
  let activated = false;
  const jobs = createBackgroundJobs(async () => {
    if (stopping || !(await dispatchReady()) || stopping) return false;
    if (!activated) {
      activated = true;
      observeRecoveredRuntimes();
      idleCompute.start();
    }
    return true;
  });
  jobs.every(
    "Native worker capacity admission is unavailable",
    () => runtimeController.admitNativeCapacity(),
    15_000,
  );
  jobs.every(
    "Recorded runtime Stop cleanup is unavailable",
    () => runtimeController.reconcileStops(),
    15_000,
  );
  jobs.every("Delivery observation failed", () => deliveryController.sweep(), 1_000, true);
  jobs.every("Input observation failed", () => monitoringWorker.sweep(), 2_000, true);
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
    "Retained Build admission failed",
    async () => agentController?.dispatchReadyPending(),
    2_000,
  );
  jobs.every(
    "Retained Stop settlement is unavailable",
    async () => agentController?.recoverRetainedStops(),
    2_000,
  );
  jobs.every(
    "Browser cleanup observation is unavailable",
    () => buildBrowserController.reconcileCleanup(),
    2_000,
    true,
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
    "Shared submission observation is unavailable",
    () => application.workspaceSubmission.recover(),
    5000,
  );
  jobs.every(
    "Implementation order observation failed",
    () => implementationOrders.reconcile(),
    1_000,
  );
  let closing: Promise<void> | undefined;
  return () => {
    stopping = true;
    closing ??= (async () => {
      // Stop admitting ticks synchronously, then abort and join owned work.
      // An irreversible Delivery already in flight is observed, never replayed.
      await Promise.all([
        // A restart during Pause or Resume leaves that outcome unconfirmed; wait for it first.
        drainNativeOperations(100_000),
        jobs.close(),
        application.workspaceCommands.close(),
        application.workspaceFiles.close(),
        application.workspaceCollaboration.close(),
        application.workspaceSubmission.close(),
        monitoringWorker.close(),
        deliveryController.close(),
        learningWorker.close(),
        projectAgentController.shutdown(),
        knowledgeController.close(),
        application.setupReadiness.close(),
      ]);
      await Promise.all([
        idleCompute.close(),
        application.accessRevocation.close(),
        application.workspaceSources?.close(),
        agentController?.shutdown(),
      ]);
    })();
    return closing;
  };
}
