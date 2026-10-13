import { createEffect, createSignal, For, Show } from "solid-js";
import { z } from "zod";
import { apiRequest, emptyResponseSchema } from "../api-client";
import { AccountActions } from "./account-actions";
import { FreshAuthentication } from "./fresh-authentication";
import "./settings.css";

const memberSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.email(),
  role: z.enum(["developer", "product-contributor"]),
  manageProject: z.boolean(),
});
const membersSchema = z.object({ members: z.array(memberSchema) });
const usersSchema = z.object({
  users: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      email: z.email(),
      systemManager: z.boolean(),
      disabled: z.boolean(),
      directoryDisabled: z.boolean(),
    }),
  ),
});
type Member = z.infer<typeof memberSchema>;

export function AccessSettings(props: {
  systemManager: boolean;
  project?: { id: string; name: string } | undefined;
  beforeCompanySignIn?: () => void;
}) {
  const [members, setMembers] = createSignal<Member[]>([]);
  const [pendingManagement, setPendingManagement] = createSignal<Record<string, boolean>>({});
  const [users, setUsers] = createSignal<z.infer<typeof usersSchema>["users"]>([]);
  const [companySignIn, setCompanySignIn] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [removing, setRemoving] = createSignal<string>();
  const [accountAction, setAccountAction] = createSignal<{
    id: string;
    kind: "disable" | "sessions";
  }>();
  let disposed = false;
  let loadVersion = 0;
  const projectPath = () =>
    props.project ? `/api/projects/${props.project.id}/members` : undefined;

  async function load() {
    const version = ++loadVersion;
    const path = projectPath();
    const [memberResult, userResult, policy] = await Promise.all([
      path ? apiRequest(membersSchema, path) : Promise.resolve({ members: [] }),
      props.systemManager && !props.project
        ? apiRequest(usersSchema, "/api/admin/users")
        : Promise.resolve({ users: [] }),
      apiRequest(z.object({ companySignIn: z.boolean() }), "/api/security/session"),
    ]);
    if (!disposed && version === loadVersion) {
      setMembers(memberResult.members);
      setUsers(userResult.users);
      setCompanySignIn(policy.companySignIn);
    }
  }
  async function act(operation: () => Promise<void>) {
    if (busy()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (cause) {
      if (!disposed) setError(cause instanceof Error ? cause.message : "Could not update access");
    } finally {
      if (!disposed) setBusy(false);
    }
  }
  async function addAccount(form: HTMLFormElement) {
    const data = new FormData(form);
    await apiRequest(z.object({ id: z.uuid() }), "/api/admin/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: data.get("name"),
        email: data.get("email"),
        password: data.get("password"),
      }),
    });
    if (disposed) return;
    form.reset();
    form.closest("details")?.removeAttribute("open");
    await load();
    if (!disposed)
      setNotice("Account created. Add access in the project's People & access settings.");
  }
  async function setMember(email: string, role: Member["role"], manageProject = false) {
    const path = projectPath();
    if (!path) return;
    await apiRequest(z.object({ userId: z.uuid(), role: memberSchema.shape.role }), path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, role, manageProject }),
    });
    await load();
    if (!disposed) setNotice("Project access saved.");
  }
  async function removeMember(member: Member) {
    const path = projectPath();
    if (!path) return;
    await apiRequest(emptyResponseSchema, `${path}/${member.userId}`, { method: "DELETE" });
    if (disposed) return;
    setRemoving(undefined);
    await load();
    if (!disposed)
      setNotice(`${member.name}'s project access was removed. Shared work is unchanged.`);
  }
  async function changeAccount(userID: string, kind: "access" | "sessions", disabled = true) {
    await apiRequest(emptyResponseSchema, `/api/admin/users/${userID}/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(kind === "access" ? { body: JSON.stringify({ disabled }) } : {}),
    });
    setAccountAction(undefined);
    await load();
    setNotice(
      kind === "sessions"
        ? "Browser sessions ended. Agents continue."
        : disabled
          ? "Account disabled. Existing work is retained."
          : "Manual account restriction removed.",
    );
  }
  createEffect(
    () => [props.project?.id, props.systemManager] as const,
    () => {
      disposed = false;
      setMembers([]);
      setUsers([]);
      setRemoving(undefined);
      setAccountAction(undefined);
      setNotice("");
      setError("");
      setBusy(true);
      const loading = load();
      const version = loadVersion;
      void loading
        .catch((cause) => {
          if (!disposed && version === loadVersion)
            setError(cause instanceof Error ? cause.message : "Could not load access");
        })
        .finally(() => {
          if (!disposed && version === loadVersion) setBusy(false);
        });
      return () => {
        disposed = true;
        loadVersion++;
      };
    },
  );

  return (
    <section class="access-settings" aria-label="People & access">
      <div class="model-settings-body access-settings-body" aria-busy={busy() ? "true" : "false"}>
        <FreshAuthentication beforeCompanySignIn={props.beforeCompanySignIn} />
        <Show when={props.systemManager && !props.project}>
          <section aria-label="Managed accounts">
            <h3>Managed accounts</h3>
            <ul class="access-list">
              <For each={users()}>
                {(user) => (
                  <li>
                    <div class="access-person">
                      <strong>{user.name}</strong>
                      <span>{user.email}</span>
                    </div>
                    <small>
                      {user.directoryDisabled
                        ? "Disabled by directory"
                        : user.disabled
                          ? "Disabled"
                          : user.systemManager
                            ? "System Manager"
                            : "Account"}
                    </small>
                    <Show
                      when={accountAction()?.id === user.id}
                      fallback={
                        <AccountActions
                          name={user.name}
                          disabled={user.disabled}
                          busy={busy()}
                          onSessions={() => setAccountAction({ id: user.id, kind: "sessions" })}
                          onDisable={() => setAccountAction({ id: user.id, kind: "disable" })}
                          onEnable={() => void act(() => changeAccount(user.id, "access", false))}
                        />
                      }
                    >
                      <div class="access-confirm">
                        <span>
                          {accountAction()?.kind === "disable"
                            ? "Disable access and stop work under this account?"
                            : "End browser sessions? Agents continue."}
                        </span>
                        <button
                          type="button"
                          class="quiet-button"
                          disabled={busy()}
                          onClick={() => setAccountAction(undefined)}
                        >
                          Keep access
                        </button>
                        <button
                          type="button"
                          class="danger-button"
                          disabled={busy()}
                          onClick={() =>
                            void act(() =>
                              changeAccount(
                                user.id,
                                accountAction()?.kind === "disable" ? "access" : "sessions",
                              ),
                            )
                          }
                        >
                          Confirm
                        </button>
                      </div>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
            <Show when={!companySignIn()}>
              <details class="access-add-account">
                <summary>Add account</summary>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget;
                    void act(() => addAccount(form));
                  }}
                >
                  <label>
                    Name
                    <input
                      name="name"
                      required
                      maxlength={200}
                      autocomplete="name"
                      disabled={busy()}
                    />
                  </label>
                  <label>
                    Email
                    <input
                      name="email"
                      type="email"
                      required
                      maxlength={320}
                      autocomplete="email"
                      disabled={busy()}
                    />
                  </label>
                  <label>
                    Initial password
                    <input
                      name="password"
                      type="password"
                      required
                      minlength={12}
                      maxlength={128}
                      autocomplete="new-password"
                      disabled={busy()}
                    />
                    <small>At least 12 characters. Share privately with the account owner.</small>
                  </label>
                  <button type="submit" class="primary-button" disabled={busy()}>
                    Create account
                  </button>
                </form>
              </details>
            </Show>
          </section>
        </Show>
        <Show when={props.project}>
          {(project) => (
            <section aria-label="Project membership">
              <h3>{project().name}</h3>
              <p class="model-settings-note">
                Everyone can view App previews. Only Developers access code; personal files and
                terminals stay private. Project management is a separate permission.
              </p>
              <ul class="access-list">
                <For each={members()}>
                  {(member) => (
                    <li>
                      <div class="access-person">
                        <strong>{member.name}</strong>
                        <span>{member.email}</span>
                      </div>
                      <Show
                        when={removing() === member.userId}
                        fallback={
                          <>
                            <select
                              aria-label={`Role for ${member.name}`}
                              value={member.role}
                              disabled={busy()}
                              onChange={(event) => {
                                const role = memberSchema.shape.role.parse(
                                  event.currentTarget.value,
                                );
                                void act(() => setMember(member.email, role, member.manageProject));
                              }}
                            >
                              <option value="developer">Developer</option>
                              <option value="product-contributor">Product Contributor</option>
                            </select>
                            <label class="access-permission">
                              <input
                                type="checkbox"
                                aria-label={`Manage project for ${member.name}`}
                                checked={pendingManagement()[member.userId] ?? member.manageProject}
                                disabled={busy()}
                                onChange={(event) => {
                                  const checked = event.currentTarget.checked;
                                  setPendingManagement((current) => ({
                                    ...current,
                                    [member.userId]: checked,
                                  }));
                                  void act(() =>
                                    setMember(member.email, member.role, checked),
                                  ).finally(() => {
                                    setPendingManagement((current) => {
                                      const next = { ...current };
                                      delete next[member.userId];
                                      return next;
                                    });
                                  });
                                }}
                              />
                              Manage project
                            </label>
                            <button
                              type="button"
                              class="quiet-button"
                              aria-label={`Remove ${member.name}'s project access`}
                              disabled={busy()}
                              onClick={() => setRemoving(member.userId)}
                            >
                              Remove
                            </button>
                          </>
                        }
                      >
                        <div class="access-confirm">
                          <span>Remove access?</span>
                          <button
                            type="button"
                            class="quiet-button"
                            disabled={busy()}
                            onClick={() => setRemoving(undefined)}
                          >
                            Keep access
                          </button>
                          <button
                            type="button"
                            class="danger-button"
                            disabled={busy()}
                            onClick={() => void act(() => removeMember(member))}
                          >
                            Confirm removal
                          </button>
                        </div>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={!busy() && members().length === 0}>
                <p class="model-settings-note">
                  No project members yet. System Managers retain access.
                </p>
              </Show>
              <form
                class="access-add-member"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const data = new FormData(form);
                  void act(async () => {
                    await setMember(
                      z.email().parse(data.get("email")),
                      memberSchema.shape.role.parse(data.get("role")),
                      data.get("manageProject") === "on",
                    );
                    if (!disposed) form.reset();
                  });
                }}
              >
                <label>
                  Member email
                  <input
                    name="email"
                    type="email"
                    required
                    autocomplete="email"
                    placeholder="Existing managed account"
                    disabled={busy()}
                  />
                </label>
                <label>
                  Role
                  <select name="role" disabled={busy()}>
                    <option value="developer">Developer</option>
                    <option value="product-contributor">Product Contributor</option>
                  </select>
                </label>
                <label class="access-permission">
                  <input name="manageProject" type="checkbox" disabled={busy()} />
                  Manage project
                </label>
                <button type="submit" class="primary-button" disabled={busy()}>
                  Add member
                </button>
              </form>
            </section>
          )}
        </Show>
        <Show when={notice()}>
          <p role="status" class="model-settings-note">
            {notice()}
          </p>
        </Show>
        <Show when={error()}>
          <div class="model-settings-error">
            <p role="alert">{error()}</p>
            <button
              type="button"
              class="quiet-button"
              disabled={busy()}
              onClick={() => void act(load)}
            >
              Reload access
            </button>
          </div>
        </Show>
      </div>
    </section>
  );
}
