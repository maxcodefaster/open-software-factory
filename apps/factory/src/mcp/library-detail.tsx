import { For, Show } from "solid-js";
import type { LibraryCoverKey } from "#conversation-domain/library-covers";
import {
  type MCPChoice,
  type MCPDefinition,
  type MCPRole,
  resolveMCPChoice,
} from "#conversation-domain/mcp-library";
import { LibraryCoverPicker } from "../library-covers/picker";
import { monitoringSourceAvailable } from "../monitoring/client";
import { WorkspaceActionBar } from "../ui/workspace-actions";
import {
  cover,
  type MCPEntry,
  type MCPScope,
  roleLabel,
  scopeLabel,
  stateLabel,
} from "./library-shared";

export function MCPLibraryDetail(props: {
  item: MCPEntry;
  scope: MCPScope;
  choices: MCPChoice[];
  projectId: string | undefined;
  projectName: string | undefined;
  monitoringSetup: boolean;
  busy: boolean;
  setupBlocked: boolean;
  hasDraft: boolean;
  token: string;
  allowed: string[];
  confirmed: boolean;
  authorization: string | undefined;
  shareTarget: "project" | "system";
  onHeadingRef: (element: HTMLHeadingElement) => void;
  onClose: () => void;
  onEdit: (content: MCPDefinition, item: MCPEntry) => void;
  onSaveCover: (
    libraryId: string,
    key: LibraryCoverKey,
    expectedVersion: number,
  ) => Promise<boolean>;
  onTokenInput: (value: string) => void;
  onConnect: () => void;
  onDisconnect: (libraryId: string) => void;
  onRefreshStatus: () => void;
  onToggleTool: (toolName: string, checked: boolean) => void;
  onConfirmedChange: (checked: boolean) => void;
  onApproveTools: (item: MCPEntry) => void;
  onToggleProjectGrant: (item: MCPEntry) => void;
  onUseForInput: (connectionId: string) => void;
  onChoose: (item: MCPEntry, role: MCPRole, state: MCPChoice["state"]) => void;
  onShareTargetChange: (target: "project" | "system") => void;
  onProposeShare: (revisionId: string) => void;
}) {
  const latest = () => props.item.revisions[0];
  return (
    <section
      class="skill-gallery-detail"
      aria-label="MCP details"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !(event.target instanceof HTMLSelectElement)) {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }
      }}
    >
      <header class="skill-detail-heading mcp-detail-heading">
        <img
          class="mcp-cover"
          src={cover(latest()?.content.provider ?? "custom", props.item.cover)}
          width="768"
          height="512"
          alt=""
        />
        <div class="skill-detail-introduction">
          <div class="workspace-heading">
            <h3 class="workspace-heading-title" tabindex="-1" ref={props.onHeadingRef}>
              {latest()?.content.name}
            </h3>
            <WorkspaceActionBar label="MCP actions">
              <button type="button" class="workspace-action" onClick={props.onClose}>
                Back to library
              </button>
              <Show
                when={
                  props.item.editable && (!props.monitoringSetup || props.item.scope === "project")
                }
              >
                <button
                  type="button"
                  class="workspace-action"
                  data-primary="true"
                  disabled={props.busy || props.setupBlocked || props.hasDraft}
                  onClick={() => {
                    const revision = latest();
                    if (revision) props.onEdit(revision.content, props.item);
                  }}
                >
                  Edit definition
                </button>
              </Show>
            </WorkspaceActionBar>
          </div>
          <p>{latest()?.content.description}</p>
          <p class="skill-detail-origin">
            {scopeLabel(props.item.scope)} library · Definition v{latest()?.revision}
          </p>
        </div>
      </header>
      <Show when={props.item.editable && !props.setupBlocked}>
        <LibraryCoverPicker
          kind="mcp"
          cover={props.item.cover}
          busy={props.busy}
          onSave={(key, expectedVersion) => props.onSaveCover(props.item.id, key, expectedVersion)}
        />
      </Show>
      <section class="mcp-connection" aria-label="MCP connection">
        <h4>{stateLabel(props.item.connection?.state)}</h4>
        <p class="mcp-endpoint">{latest()?.content.endpoint}</p>
        <Show when={props.item.connection && props.item.connection?.revisionId !== latest()?.id}>
          <p>
            The saved definition is newer than the connected version. Reconnect and review it before
            adopting it for new work. Existing choices have not changed.
          </p>
        </Show>
        <Show when={props.item.connection}>
          <details open={!props.monitoringSetup}>
            <summary hidden={!props.monitoringSetup}>Changing account access</summary>
            <p class="skill-help">
              Reconnect replaces the account authorization
              {props.item.scope === "system" ? " and requires new Project grants" : ""}. Work
              admitted with the old connection cannot perform further lookups. Disconnect blocks new
              lookups here; revoke or rotate the provider credential separately when needed.
            </p>
          </details>
        </Show>
        <Show
          when={props.item.editable}
          fallback={
            <p>
              Ask the connection manager to authorize and grant access. Credentials are never shown
              here.
            </p>
          }
        >
          <Show when={latest()?.content.authentication === "bearer"}>
            <label>
              Read-only access token
              <input
                type="password"
                autocomplete="off"
                value={props.token}
                onInput={(event) => props.onTokenInput(event.currentTarget.value)}
              />
            </label>
          </Show>
          <div class="mcp-actions">
            <button
              type="button"
              class={
                props.monitoringSetup && props.item.connection?.state === "ready"
                  ? "quiet-button"
                  : "primary-button"
              }
              disabled={props.busy || props.setupBlocked}
              onClick={props.onConnect}
            >
              {props.item.connection ? "Reconnect" : "Connect"}
            </button>
            <Show when={props.item.connection && props.item.connection?.state !== "revoked"}>
              <button
                type="button"
                class="quiet-button"
                disabled={props.busy || props.setupBlocked}
                onClick={() => props.onDisconnect(props.item.id)}
              >
                Disconnect
              </button>
            </Show>
          </div>
          <Show when={props.authorization}>
            {(url) => (
              <p>
                <a href={url()} target="_blank" rel="noopener noreferrer">
                  Continue sign-in
                </a>{" "}
                ·{" "}
                <button type="button" class="quiet-button" onClick={props.onRefreshStatus}>
                  Refresh status
                </button>
              </p>
            )}
          </Show>
          <Show when={props.item.connection?.state === "authorizing"}>
            <p>Finish sign-in in the provider tab, then return here to review access.</p>
          </Show>
        </Show>
      </section>
      <Show
        when={
          props.item.editable &&
          props.item.connection &&
          ["review", "ready"].includes(props.item.connection?.state ?? "") &&
          (!props.monitoringSetup || props.item.connection?.state === "review")
        }
      >
        <section class="mcp-tool-review" aria-label="Read-only tool review">
          <h4>Review read-only access</h4>
          <p>
            Approve only tools you have checked. Server hints are suggestions, not proof. Use a
            provider account whose permissions are limited to reading.
          </p>
          <For each={props.item.connection?.tools}>
            {(tool) => (
              <div class="mcp-tool">
                <label class="mcp-checkbox">
                  <input
                    type="checkbox"
                    checked={props.allowed.includes(tool.name)}
                    onChange={(event) => props.onToggleTool(tool.name, event.currentTarget.checked)}
                  />
                  {tool.name}
                </label>
                <p>{tool.description}</p>
                <small>
                  {tool.readOnlyHint ? "Server declares read-only" : "No read-only declaration"}
                </small>
                <details>
                  <summary>Input schema</summary>
                  <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                </details>
              </div>
            )}
          </For>
          <label class="mcp-checkbox">
            <input
              type="checkbox"
              checked={props.confirmed}
              onChange={(event) => props.onConfirmedChange(event.currentTarget.checked)}
            />
            I verified the selected tools and provider access are read-only.
          </label>
          <button
            type="button"
            class="primary-button"
            disabled={props.busy || props.setupBlocked || !props.confirmed || !props.allowed.length}
            onClick={() => props.onApproveTools(props.item)}
          >
            Approve read-only access
          </button>
        </section>
      </Show>
      <Show
        when={
          props.item.editable &&
          props.item.scope === "system" &&
          props.item.connection &&
          props.projectId
        }
      >
        <section class="mcp-grants" aria-label="Project connection access">
          <h4>Access for {props.projectName ?? "this Project"}</h4>
          <p>
            Granting access permits this Project to read the data available to this connection. It
            does not copy credentials.
          </p>
          <button
            type="button"
            class="quiet-button"
            disabled={
              props.busy ||
              props.setupBlocked ||
              (props.item.connection?.state !== "ready" &&
                !props.item.connection?.projectGrants.includes(props.projectId ?? ""))
            }
            onClick={() => props.onToggleProjectGrant(props.item)}
          >
            {props.item.connection?.projectGrants.includes(props.projectId ?? "")
              ? "Revoke Project access"
              : "Grant Project access"}
          </button>
        </section>
      </Show>
      <Show when={props.monitoringSetup}>
        <section class="mcp-monitoring-next" aria-label="Continue Input setup">
          <h4>Continue setting up your Input</h4>
          <Show when={props.item.connection?.state === "ready"}>
            <p>Read-only access approved.</p>
          </Show>
          <p>
            This connection supplies context for incoming requests and their implementation. The
            Input's task and approval settings remain separate.
          </p>
          <Show
            when={
              !latest()?.content.roles.includes("planning") ||
              !latest()?.content.roles.includes("build")
            }
          >
            <p>This source must be available for both Investigate &amp; Plan and Build.</p>
          </Show>
          <Show
            when={
              props.item.scope === "system" &&
              !props.item.connection?.projectGrants.includes(props.projectId ?? "")
            }
          >
            <p>Grant this Project access above before continuing.</p>
          </Show>
          <button
            type="button"
            class="primary-button"
            disabled={
              props.busy ||
              props.setupBlocked ||
              !monitoringSourceAvailable(props.item, props.projectId ?? "")
            }
            onClick={() => props.onUseForInput(props.item.id)}
          >
            Use for Input
          </button>
        </section>
      </Show>
      <section
        class="skill-availability"
        aria-label="MCP availability"
        hidden={props.monitoringSetup}
      >
        <h4>
          {props.scope === "personal"
            ? `For you${props.projectName ? ` in ${props.projectName}` : ""}`
            : props.scope === "project"
              ? `Defaults for ${props.projectName ?? "this Project"}`
              : "Defaults for everyone in Factory"}
        </h4>
        <Show when={!props.projectId && props.scope !== "system"}>
          <p>Select a Project to enable connections. Your personal library spans Projects.</p>
        </Show>
        <For each={latest()?.content.roles}>
          {(role) => {
            const effective = () => resolveMCPChoice(props.choices, props.item.id, role);
            const own = () =>
              props.choices.find(
                (choice) =>
                  choice.libraryId === props.item.id &&
                  choice.role === role &&
                  choice.scope === props.scope,
              );
            const locked = () =>
              effective()?.state === "required" && effective()?.scope !== props.scope;
            const choiceLabel = () => {
              const choice = effective();
              if (!choice) return "Off until enabled";
              return locked()
                ? `Required by ${scopeLabel(choice.scope)} policy`
                : `${choice.state === "disable" ? "Off" : "Enabled"} by ${scopeLabel(choice.scope)} choice`;
            };
            const activationBlock = () => {
              if (props.item.connection?.state !== "ready")
                return "Connect and approve read-only access before enabling.";
              if (props.item.connection?.revisionId !== latest()?.id)
                return "Connect and review this definition version before enabling.";
              if (
                props.scope !== "system" &&
                props.item.scope === "system" &&
                props.projectId &&
                !props.item.connection?.projectGrants.includes(props.projectId)
              )
                return "Grant this Project access before enabling.";
              return "";
            };
            return (
              <div class="skill-choice">
                <label>
                  {roleLabel(role)} choice
                  <select
                    aria-label={`${latest()?.content.name} ${roleLabel(role)} choice`}
                    disabled={
                      props.busy || locked() || (!props.projectId && props.scope !== "system")
                    }
                    value={own()?.state ?? "inherit"}
                    onChange={(event) =>
                      props.onChoose(
                        props.item,
                        role,
                        event.currentTarget.value as MCPChoice["state"],
                      )
                    }
                  >
                    <option value="inherit">Inherit</option>
                    <option value="enable" disabled={Boolean(activationBlock())}>
                      Enable
                    </option>
                    <option value="disable">Disable</option>
                    <Show when={props.scope !== "personal"}>
                      <option value="required" disabled={Boolean(activationBlock())}>
                        Required
                      </option>
                    </Show>
                  </select>
                  <small>{choiceLabel()}</small>
                  <Show when={activationBlock()}>
                    <small>{activationBlock()}</small>
                  </Show>
                </label>
                <Show
                  when={
                    !locked() &&
                    effective() &&
                    effective()?.revisionId !== latest()?.id &&
                    props.item.connection?.revisionId === latest()?.id &&
                    props.item.connection?.state === "ready"
                  }
                >
                  <button
                    type="button"
                    class="quiet-button"
                    disabled={props.busy || Boolean(activationBlock())}
                    onClick={() =>
                      props.onChoose(
                        props.item,
                        role,
                        props.scope !== "personal" && own()?.state === "required"
                          ? "required"
                          : "enable",
                      )
                    }
                  >
                    Use connected v{latest()?.revision} for new work
                  </button>
                </Show>
              </div>
            );
          }}
        </For>
        <p class="skill-help">
          Choices apply to new work. Access revocation takes effect immediately. Personal results
          used here become visible in shared Project work.
        </p>
      </section>
      <Show when={props.item.revisions.length > 1}>
        <details class="skill-version-history">
          <summary>Definition history</summary>
          <For each={props.item.revisions}>
            {(revision) => (
              <section>
                <h4>
                  v{revision.revision} · {revision.content.name}
                </h4>
                <p>{revision.content.description}</p>
                <p class="mcp-endpoint">{revision.content.endpoint}</p>
                <p>
                  {revision.content.authentication} ·{" "}
                  {revision.content.roles.map(roleLabel).join(", ")}
                </p>
              </section>
            )}
          </For>
        </details>
      </Show>
      <Show
        when={
          !props.monitoringSetup && props.item.scope === "personal" && props.scope === "personal"
        }
      >
        <details class="skill-sharing">
          <summary>Share this MCP definition</summary>
          <p>
            Propose the displayed version for manager review. Your credentials and other private
            versions stay private.
          </p>
          <label>
            Share with
            <select
              value={props.projectId ? props.shareTarget : "system"}
              onChange={(event) =>
                props.onShareTargetChange(event.currentTarget.value as "project" | "system")
              }
            >
              <Show when={props.projectId}>
                <option value="project">{props.projectName ?? "This Project"}</option>
              </Show>
              <option value="system">Factory</option>
            </select>
          </label>
          <button
            type="button"
            class="quiet-button"
            disabled={props.busy}
            onClick={() => {
              const revision = latest();
              if (revision) props.onProposeShare(revision.id);
            }}
          >
            Propose shared definition
          </button>
        </details>
      </Show>
    </section>
  );
}
