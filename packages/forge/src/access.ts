import { z } from "zod";

const account = z
  .object({
    id: z.number().int().positive(),
    login: z.string(),
    login_name: z.string(),
    source_id: z.number().int(),
    active: z.boolean(),
    prohibit_login: z.boolean(),
    is_admin: z.boolean(),
    restricted: z.boolean(),
  })
  .loose();
const protection = z
  .object({
    rule_name: z.string(),
    enable_push: z.boolean(),
    enable_push_whitelist: z.boolean(),
    push_whitelist_usernames: z.array(z.string()).nullable(),
    push_whitelist_teams: z.array(z.string()).nullable(),
    push_whitelist_deploy_keys: z.boolean(),
    enable_merge_whitelist: z.boolean(),
    merge_whitelist_usernames: z.array(z.string()).nullable(),
    merge_whitelist_teams: z.array(z.string()).nullable(),
    apply_to_admins: z.boolean(),
  })
  .loose();

export function forgeUsername(userID: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(userID))
    throw new Error("Factory identity must be a UUID");
  return `factory-${userID.replaceAll("-", "").toLowerCase()}`;
}

// Native Forgejo administration is a separate infrastructure credential, never a user token.
export function createForgejoAccess(options: {
  apiURL: string;
  token: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}) {
  const base = new URL(options.apiURL.endsWith("/") ? options.apiURL : `${options.apiURL}/`);
  async function request(path: string, method = "GET", body?: unknown) {
    const response = await (options.fetch ?? fetch)(new URL(path, base), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok && response.status !== 404)
      throw new Error(`Forge access operation failed with HTTP ${response.status}`);
    return response;
  }
  const segment = (value: string) => encodeURIComponent(value);
  async function readAccount(username: string) {
    const response = await request(`users/${segment(username)}`);
    return response.status === 404 ? undefined : account.parse(await response.json());
  }
  async function pages(path: string) {
    const records: unknown[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await request(`${path}?limit=50&page=${page}`);
      if (response.status === 404) throw new Error("Forge access inventory is unavailable");
      const values = z.array(z.unknown()).parse(await response.json());
      records.push(...values);
      if (values.length < 50) return records;
    }
    throw new Error("Forge access inventory exceeds its bound");
  }
  return {
    readAccount,
    async ensureAccount(input: {
      userID: string;
      sourceID: number;
      email: string;
      name: string;
      enabled: boolean;
      suspended?: boolean;
    }) {
      const username = forgeUsername(input.userID);
      let existing = await readAccount(username);
      if (!existing && !input.enabled && !input.suspended) return undefined;
      if (!existing) {
        try {
          const response = await request("admin/users", "POST", {
            username,
            email: input.email,
            full_name: input.name,
            source_id: input.sourceID,
            login_name: input.userID,
            restricted: true,
            must_change_password: false,
            send_notify: false,
            visibility: "private",
          });
          if (response.status === 404) throw new Error("Forge administration is unavailable");
          existing = account.parse(await response.json());
        } catch (cause) {
          existing = await readAccount(username);
          if (!existing) throw cause;
        }
      }
      if (
        existing.login !== username ||
        existing.source_id !== input.sourceID ||
        existing.login_name !== input.userID
      )
        throw new Error("Forge identity differs from the recorded Factory identity");
      const response = await request(`admin/users/${segment(username)}`, "PATCH", {
        source_id: input.sourceID,
        login_name: input.userID,
        full_name: input.name,
        active: input.enabled || input.suspended === true,
        prohibit_login: !input.enabled,
        admin: false,
        restricted: true,
        allow_create_organization: false,
        allow_git_hook: false,
        allow_import_local: false,
        max_repo_creation: 0,
        hide_email: true,
        visibility: "private",
      });
      const observed = account.parse(await response.json());
      if (
        observed.active !== (input.enabled || input.suspended === true) ||
        observed.prohibit_login === input.enabled ||
        observed.is_admin ||
        !observed.restricted
      )
        throw new Error("Forge account prohibition was not confirmed");
      return observed.id;
    },
    async removeAlternativeGrants(
      userID: string,
      allowed: readonly { owner: string; name: string }[] = [],
    ) {
      const username = forgeUsername(userID);
      const person = await readAccount(username);
      if (!person) return;
      const organizations = z
        .array(z.object({ username: z.string() }).loose())
        .parse(await pages(`users/${segment(username)}/orgs`));
      for (const organization of organizations)
        await request(
          `orgs/${segment(organization.username)}/members/${segment(username)}`,
          "DELETE",
        );
      if ((await pages(`users/${segment(username)}/orgs`)).length)
        throw new Error("Forge organization grants remain active");
      // Inventory first. Removing grants while paging changes the result offsets.
      const repositories: { name: string; private: boolean; owner: { login: string } }[] = [];
      let complete = false;
      for (let page = 1; page <= 100; page++) {
        const response = await request(
          `repos/search?uid=${person.id}&private=true&limit=50&page=${page}`,
        );
        const result = z
          .object({
            data: z.array(
              z
                .object({
                  name: z.string(),
                  private: z.boolean(),
                  owner: z.object({ login: z.string() }).loose(),
                })
                .loose(),
            ),
          })
          .loose()
          .parse(await response.json());
        repositories.push(...result.data);
        if (result.data.length < 50) {
          complete = true;
          break;
        }
      }
      if (!complete) throw new Error("Forge repository grants exceed their inventory bound");
      for (const repository of repositories) {
        if (repository.owner.login === username)
          throw new Error("Factory identities must not own native repositories");
        if (
          allowed.some(
            (grant) => grant.owner === repository.owner.login && grant.name === repository.name,
          )
        )
          continue;
        const path = `repos/${segment(repository.owner.login)}/${segment(repository.name)}/collaborators/${segment(username)}`;
        await request(path, "DELETE");
        const permission = await request(`${path}/permission`);
        if (permission.status !== 404 && repository.private) {
          const observed = z
            .object({ permission: z.string() })
            .loose()
            .parse(await permission.json());
          if (!["none", ""].includes(observed.permission))
            throw new Error("Forge repository retains an unapproved grant");
        }
      }
    },
    async repositoryGrant(owner: string, repository: string, userID: string, enabled: boolean) {
      if (enabled) {
        const response = await request(`repos/${segment(owner)}/${segment(repository)}`);
        if (response.status === 404) throw new Error("Factory repository is missing");
        const observed = z
          .object({
            private: z.boolean(),
            name: z.string(),
            owner: z.object({ login: z.string() }).loose(),
          })
          .loose()
          .parse(await response.json());
        if (!observed.private || observed.name !== repository || observed.owner.login !== owner)
          throw new Error("Factory repository must have its exact private identity");
      }
      const path = `repos/${segment(owner)}/${segment(repository)}/collaborators/${segment(forgeUsername(userID))}`;
      await request(
        path,
        enabled ? "PUT" : "DELETE",
        enabled ? { permission: "write" } : undefined,
      );
      const response = await request(`${path}/permission`);
      if (response.status === 404) {
        if (enabled) throw new Error("Forge repository grant is missing");
        return;
      }
      const observed = z
        .object({ permission: z.string() })
        .loose()
        .parse(await response.json());
      if (
        enabled
          ? observed.permission !== "write"
          : !["none", "", "read"].includes(observed.permission)
      )
        throw new Error("Forge repository grant differs from Factory permission");
      if (!enabled && observed.permission === "read")
        throw new Error("Forge repository retains an alternative read grant");
    },
    async protectBranch(input: {
      owner: string;
      repository: string;
      branch: string;
      writers: readonly string[];
      merger: string;
      protectedFiles?: string;
    }) {
      const path = `repos/${segment(input.owner)}/${segment(input.repository)}/branch_protections`;
      const desired = {
        enable_push: input.writers.length > 0,
        enable_push_whitelist: input.writers.length > 0,
        push_whitelist_usernames: [...input.writers].sort(),
        push_whitelist_teams: [],
        push_whitelist_deploy_keys: false,
        enable_merge_whitelist: true,
        merge_whitelist_usernames: [input.merger],
        merge_whitelist_teams: [],
        apply_to_admins: true,
        ...(input.protectedFiles !== undefined
          ? { protected_file_patterns: input.protectedFiles }
          : {}),
      };
      const current = await request(`${path}/${segment(input.branch)}`);
      try {
        await request(
          current.status === 404 ? path : `${path}/${segment(input.branch)}`,
          current.status === 404 ? "POST" : "PATCH",
          { ...desired, rule_name: input.branch },
        );
      } catch (cause) {
        const recovered = await request(`${path}/${segment(input.branch)}`);
        if (recovered.status === 404) throw cause;
      }
      const observed = protection.parse(
        await (await request(`${path}/${segment(input.branch)}`)).json(),
      );
      if (
        observed.rule_name !== input.branch ||
        observed.enable_push !== desired.enable_push ||
        observed.enable_push_whitelist !== desired.enable_push_whitelist ||
        JSON.stringify([...(observed.push_whitelist_usernames ?? [])].sort()) !==
          JSON.stringify(desired.push_whitelist_usernames) ||
        (observed.push_whitelist_teams?.length ?? 0) ||
        observed.push_whitelist_deploy_keys ||
        !observed.enable_merge_whitelist ||
        JSON.stringify(observed.merge_whitelist_usernames) !== JSON.stringify([input.merger]) ||
        (observed.merge_whitelist_teams?.length ?? 0) ||
        !observed.apply_to_admins
      )
        throw new Error("Forge branch writer protection was not confirmed");
    },
  };
}
