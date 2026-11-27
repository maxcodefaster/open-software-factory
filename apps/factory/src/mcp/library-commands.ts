import type { Accessor } from "solid-js";
import type { LibraryCoverKey } from "#conversation-domain/library-covers";
import {
  type MCPChoice,
  type MCPLibraryView,
  type MCPRole,
  mcpSaveContent,
} from "#conversation-domain/mcp-library";
import { plainErrorMessage } from "../command-error";
import {
  acceptMCPSharing,
  connectMCP,
  disconnectMCP,
  getMCPLibrary,
  grantMCPProject,
  proposeMCPSharing,
  reviewMCPAccess,
  saveMCPChoice,
  saveMCPCover,
  saveMCPDefinition,
} from "../server-functions/mcp";
import { serverCall } from "../server-functions/result";
import type { MCPEntry, MCPScope } from "./library-shared";
import {
  applyMCPConnectResult,
  beginMCPLoad,
  clearMCPAuthorization,
  finishMCPLoad,
  finishMCPMutation,
  initialMCPDraftState,
  isMCPBusy,
  type MCPActivityState,
  type MCPDetailInteractionState,
  type MCPDraftState,
  resetMCPDetailInteraction,
  resolvePendingMCPSave,
  syncMCPDetailAfterLoad,
} from "./library-state";

export function createMCPLibraryCommands(options: {
  projectId: Accessor<string | undefined>;
  monitoringSetup: Accessor<boolean>;
  setupBlocked: Accessor<boolean>;
  draftForMonitoring: Accessor<boolean>;
  view: Accessor<MCPLibraryView | undefined>;
  setView: (view: MCPLibraryView) => void;
  scope: Accessor<MCPScope>;
  selected: Accessor<string | undefined>;
  entry: Accessor<MCPEntry | undefined>;
  activity: Accessor<MCPActivityState>;
  updateActivity: (updater: (current: MCPActivityState) => MCPActivityState) => void;
  draftState: Accessor<MCPDraftState>;
  detailState: Accessor<MCPDetailInteractionState>;
  setDraftState: (next: MCPDraftState) => void;
  updateDetailState: (
    updater: (current: MCPDetailInteractionState) => MCPDetailInteractionState,
  ) => void;
  setEditor: (open: boolean) => void;
  setSelected: (id: string | undefined) => void;
  setScope: (scope: MCPScope) => void;
  onFocusDetail: () => void;
}) {
  let sequence = 0;

  function invalidateLoads() {
    sequence++;
  }

  function setError(error: string) {
    options.updateActivity((prev) => ({ ...prev, error }));
  }

  async function load(projectId: string | undefined, quiet = false) {
    const current = ++sequence;
    options.updateActivity((prev) => beginMCPLoad(prev, quiet));
    try {
      const result = await serverCall(
        projectId ? getMCPLibrary({ data: [projectId] }) : getMCPLibrary({ data: [] }),
      );
      if (current !== sequence) return;
      options.updateActivity((prev) => ({ ...prev, readError: "" }));
      const selectedId = options.selected();
      const previousEntry = options.view()?.entries.find((item) => item.id === selectedId);
      const nextEntry = result.entries.find((item) => item.id === selectedId);
      options.updateDetailState((prev) => syncMCPDetailAfterLoad(prev, previousEntry, nextEntry));
      if (JSON.stringify(options.view()) !== JSON.stringify(result)) options.setView(result);
      const currentScope = options.scope();
      if (
        (currentScope === "system" && !result.canManageSystem) ||
        (currentScope === "project" && !result.canManageProject)
      )
        options.setScope("personal");
      return result;
    } catch (cause) {
      if (current === sequence)
        options.updateActivity((prev) => ({
          ...prev,
          readError:
            cause instanceof Error
              ? plainErrorMessage(cause.message)
              : "Could not load connections.",
        }));
    } finally {
      if (current === sequence) options.updateActivity((prev) => finishMCPLoad(prev, quiet));
    }
  }

  async function mutate(action: () => Promise<unknown>, text: string) {
    if (isMCPBusy(options.activity())) return false;
    options.updateActivity((prev) => ({
      kind: "mutating",
      refreshing: false,
      message: "",
      error: "",
      readError: prev.readError,
    }));
    try {
      await action();
      options.updateActivity((prev) => ({ ...prev, message: text }));
      await load(options.projectId());
      return true;
    } catch (cause) {
      options.updateActivity((prev) => ({
        ...prev,
        error:
          cause instanceof Error
            ? plainErrorMessage(cause.message)
            : "The MCP action failed. Try again.",
      }));
      return false;
    } finally {
      options.updateActivity(finishMCPMutation);
    }
  }

  async function saveDraft(event: SubmitEvent) {
    event.preventDefault();
    const currentState = options.draftState();
    if (
      currentState.kind !== "draft" ||
      options.setupBlocked() ||
      (options.monitoringSetup() && !options.draftForMonitoring())
    )
      return;
    const parsed = mcpSaveContent.safeParse(currentState.draft.content);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the MCP definition");
      return;
    }
    const { nextState, submitted } = resolvePendingMCPSave(currentState, parsed.data);
    options.setDraftState(nextState);
    const libraryId = submitted.input.libraryId;
    const saved = await mutate(
      async () => {
        await serverCall(saveMCPDefinition({ data: [submitted.input] }));
        options.setDraftState(initialMCPDraftState());
        options.setEditor(false);
        options.setSelected(libraryId);
        options.setScope(currentState.draft.scope);
        options.updateDetailState((detail) => ({ ...detail, allowed: [], confirmed: false }));
      },
      options.monitoringSetup()
        ? "Project connection saved. Connect and review read-only access to continue."
        : "MCP definition saved. Connect and review access before enabling it.",
    );
    if (saved) options.onFocusDetail();
  }

  async function choose(item: MCPEntry, role: MCPRole, state: MCPChoice["state"]) {
    const revision = item.revisions[0];
    if (!revision) {
      setError("This MCP definition has no saved version. Reload before continuing.");
      return;
    }
    const scope = options.scope();
    const projectId = options.projectId();
    const current = options
      .view()
      ?.choices.find(
        (choice) => choice.libraryId === item.id && choice.role === role && choice.scope === scope,
      );
    await mutate(
      () =>
        serverCall(
          saveMCPChoice({
            data: [
              {
                libraryId: item.id,
                revisionId: revision.id,
                scope,
                role,
                state,
                expectedVersion: current?.version ?? 0,
                ...(scope !== "system" && projectId ? { projectId } : {}),
              },
            ],
          }),
        ),
      "MCP choice saved for new work.",
    );
  }

  async function connect() {
    const item = options.entry();
    if (!item || options.setupBlocked()) return;
    const revision = item.revisions[0];
    if (!revision) {
      setError("This MCP definition has no saved version. Reload before continuing.");
      return;
    }
    const token = options.detailState().token;
    options.updateDetailState(clearMCPAuthorization);
    await mutate(async () => {
      const result = await serverCall(
        connectMCP({
          data: [
            item.id,
            {
              commandId: crypto.randomUUID(),
              revisionId: revision.id,
              expectedVersion: item.connection?.version ?? 0,
              ...(revision.content.authentication === "bearer" ? { token } : {}),
            },
          ],
        }),
      );
      options.updateDetailState((current) =>
        applyMCPConnectResult(current, result.authorizationUrl),
      );
    }, "Continue sign-in if requested, then review read-only access.");
  }

  function saveCover(libraryId: string, key: LibraryCoverKey, expectedVersion: number) {
    return mutate(
      () => serverCall(saveMCPCover({ data: [{ libraryId, key, expectedVersion }] })),
      "Cover saved. Connection access is unchanged.",
    );
  }

  function disconnect(libraryId: string) {
    void mutate(
      () => serverCall(disconnectMCP({ data: [libraryId] })),
      "Connection disconnected. Further MCP lookups are blocked.",
    );
  }

  function approveTools(item: MCPEntry) {
    const connection = item.connection;
    if (!connection) return;
    const allowed = options.detailState().allowed;
    void mutate(
      () =>
        serverCall(
          reviewMCPAccess({
            data: [
              item.id,
              {
                expectedVersion: connection.version,
                confirmReadOnlyAccess: true,
                tools: connection.tools
                  .filter((tool) => allowed.includes(tool.name))
                  .map(({ name, digest }) => ({ name, digest })),
              },
            ],
          }),
        ),
      options.monitoringSetup()
        ? "Read-only access approved. Continue to the Input."
        : "Read-only access approved. Choose where to enable this connection.",
    );
  }

  function toggleProjectGrant(item: MCPEntry) {
    const connection = item.connection;
    const projectId = options.projectId();
    if (!connection || !projectId) return;
    void mutate(
      () =>
        serverCall(
          grantMCPProject({
            data: [
              item.id,
              {
                projectId,
                expectedVersion: connection.version,
                enabled: !connection.projectGrants.includes(projectId),
              },
            ],
          }),
        ),
      "Project connection access updated.",
    );
  }

  function proposeShare(revisionId: string) {
    const projectId = options.projectId();
    const target = projectId ? options.detailState().shareTarget : "system";
    void mutate(
      () =>
        serverCall(
          proposeMCPSharing({
            data: [
              {
                id: crypto.randomUUID(),
                revisionId,
                target,
                ...(projectId && target === "project" ? { projectId } : {}),
              },
            ],
          }),
        ),
      "Definition proposed for manager review. No credentials were shared.",
    );
  }

  function acceptProposal(proposalId: string) {
    void mutate(async () => {
      const result = await serverCall(acceptMCPSharing({ data: [proposalId] }));
      options.setSelected(result.libraryId);
      options.updateDetailState((current) => resetMCPDetailInteraction(current, current.allowed));
    }, "Definition added to the shared library. Connect it separately.");
  }

  function refreshStatus() {
    void mutate(() => load(options.projectId()), "Connection status refreshed.");
  }

  return {
    load,
    invalidateLoads,
    saveDraft,
    choose,
    connect,
    saveCover,
    disconnect,
    approveTools,
    toggleProjectGrant,
    proposeShare,
    acceptProposal,
    refreshStatus,
  };
}
