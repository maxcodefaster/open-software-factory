import { createHash } from "node:crypto";
import { z } from "zod";
import type { ForgeRepository } from "./forge";

const user = z
  .object({
    id: z.number(),
    login: z.string(),
    email: z.string(),
    is_admin: z.boolean(),
    source_id: z.number(),
    restricted: z.boolean(),
  })
  .loose();
const run = z.object({
  id: z.number(),
  index_in_repo: z.number(),
  commit_sha: z.string(),
  event: z.string(),
  trigger_event: z.string(),
  event_payload: z.string(),
  workflow_id: z.string(),
  status: z.string(),
  html_url: z.string(),
  trigger_user: z.object({ login: z.string() }).loose(),
});
export type PublicationRun = Omit<z.output<typeof run>, "trigger_event">;
function readRun(input: unknown): PublicationRun {
  const { trigger_event, ...value } = run.parse(input);
  // On the pinned Forgejo, dispatch has an empty webhook event. The trigger is authoritative.
  return { ...value, event: trigger_event === "workflow_dispatch" ? trigger_event : value.event };
}
const job = z
  .object({
    id: z.number(),
    handle: z.string(),
    name: z.string(),
    task_id: z.number(),
    runs_on: z.array(z.string()),
    status: z.string(),
  })
  .loose();
const task = z
  .object({
    id: z.number(),
    run_number: z.number(),
    head_sha: z.string(),
    event: z.string(),
    workflow_id: z.string(),
    status: z.string(),
  })
  .loose();
const segment = encodeURIComponent;

// Native Forgejo publication and machine access. No consumer endpoints are accepted.
export function createForgejoReleases(options: {
  apiURL: string;
  token: string;
  adminToken?: string;
  fetch?: typeof fetch;
}) {
  const base = new URL(options.apiURL.endsWith("/") ? options.apiURL : `${options.apiURL}/`);
  const origin = new URL("/", base);
  const send = options.fetch ?? fetch;
  const path = (repo: ForgeRepository) => `repos/${segment(repo.owner)}/${segment(repo.name)}`;
  async function request(
    route: string,
    method = "GET",
    body?: unknown,
    authentication = `Bearer ${options.token}`,
  ) {
    const response = await send(new URL(route, base), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: authentication,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok && response.status !== 404) {
      await response.body?.cancel();
      throw new Error(`Forgejo publication operation failed (${response.status})`);
    }
    return response;
  }
  function admin() {
    if (!options.adminToken)
      throw new Error("Forgejo machine access administration is unavailable");
    return `Bearer ${options.adminToken}`;
  }
  async function pages(route: string) {
    const all: unknown[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await request(
        `${route}${route.includes("?") ? "&" : "?"}limit=50&page=${page}`,
      );
      if (!response.ok) throw new Error("Forgejo publication inventory is unavailable");
      const data = await response.json();
      const values = Array.isArray(data) ? data : (data?.workflow_runs ?? []);
      const rows = z.array(z.unknown()).parse(values);
      all.push(...rows);
      if (rows.length < 50) return all;
    }
    throw new Error("Forgejo publication inventory exceeds its bound");
  }
  return {
    configuredAccess: Boolean(options.adminToken),
    async dispatch(repo: ForgeRepository, sha: string, id: string, version: string, owner: string) {
      const response = await request(
        `${path(repo)}/actions/workflows/factory-release.yml/dispatches`,
        "POST",
        {
          ref: sha,
          return_run_info: true,
          inputs: { factory_release_id: id, version, package_owner: owner },
        },
      );
      if (response.status !== 201) throw new Error("Forgejo did not confirm the publication run");
      return z
        .object({ id: z.number(), run_number: z.number(), jobs: z.array(z.string()) })
        .parse(await response.json());
    },
    async runs(repo: ForgeRepository, sha: string) {
      return (await pages(`${path(repo)}/actions/runs?head_sha=${sha}`)).map(readRun);
    },
    async run(repo: ForgeRepository, id: number) {
      const response = await request(`${path(repo)}/actions/runs/${id}`);
      return response.ok ? readRun(await response.json()) : null;
    },
    async jobs(repo: ForgeRepository, label: string) {
      // This API expects all labels a runner offers, not a search intersection.
      const labels =
        label && label !== "factory-publication" ? `factory-publication,${label}` : label;
      const response = await request(
        `${path(repo)}/actions/runners/jobs${labels ? `?labels=${segment(labels)}` : ""}`,
      );
      if (!response.ok) throw new Error("Publication jobs are unavailable");
      return (
        z
          .array(job)
          .nullable()
          .parse(await response.json()) ?? []
      );
    },
    async attestTask(repo: ForgeRepository, handle: string, expected: PublicationRun) {
      const jobs = await this.jobs(repo, "");
      const current = jobs.find((value) => value.handle === handle && value.status === "running");
      if (!current?.task_id) return false;
      const tasks = z.array(task).parse(await pages(`${path(repo)}/actions/tasks?status=running`));
      const running = tasks.find((value) => value.id === current.task_id);
      return Boolean(
        running &&
          running.run_number === expected.index_in_repo &&
          running.head_sha === expected.commit_sha &&
          running.workflow_id === expected.workflow_id &&
          running.event === "workflow_dispatch" &&
          expected.status === "running",
      );
    },
    async ensureMachine(username: string, password: string) {
      let response = await request(`users/${segment(username)}`, "GET", undefined, admin());
      if (response.status === 404) {
        await request(
          "admin/users",
          "POST",
          {
            username,
            password,
            email: `${username}@factory.invalid`,
            restricted: true,
            must_change_password: false,
            send_notify: false,
            visibility: "private",
          },
          admin(),
        );
        response = await request(`users/${segment(username)}`, "GET", undefined, admin());
      }
      const account = user.parse(await response.json());
      if (
        account.login !== username ||
        account.email !== `${username}@factory.invalid` ||
        account.is_admin ||
        account.source_id !== 0 ||
        !account.restricted
      )
        throw new Error("Existing native identity is not the intended restricted Factory machine");
      const observed = await request(
        `admin/users/${segment(username)}`,
        "PATCH",
        {
          active: true,
          prohibit_login: false,
          admin: false,
          restricted: true,
          allow_create_organization: false,
          allow_git_hook: false,
          allow_import_local: false,
          max_repo_creation: 0,
          visibility: "private",
        },
        admin(),
      );
      const configured = z
        .object({ is_admin: z.boolean(), restricted: z.boolean() })
        .loose()
        .parse(await observed.json());
      if (configured.is_admin || !configured.restricted)
        throw new Error("Machine account restriction was not confirmed");
      return account.id;
    },
    async ensurePackageOwner(owner: string) {
      const observed = await request(`orgs/${segment(owner)}`, "GET", undefined, admin());
      if (observed.status === 404)
        await request(
          "orgs",
          "POST",
          { username: owner, visibility: "private", repo_admin_change_team_access: false },
          admin(),
        );
      const response = await request(`orgs/${segment(owner)}`, "GET", undefined, admin());
      const org = z
        .object({ username: z.string(), visibility: z.string() })
        .loose()
        .parse(await response.json());
      if (org.username !== owner || org.visibility !== "private")
        throw new Error("Private package owner was not confirmed");
    },
    async packageGrant(owner: string, username: string, write: boolean) {
      await this.ensurePackageOwner(owner);
      const route = `orgs/${segment(owner)}/teams`;
      let response = await request(`${route}?limit=50`, "GET", undefined, admin());
      const teams = z
        .array(z.object({ id: z.number(), name: z.string(), permission: z.string() }).loose())
        .parse(await response.json());
      const name = write ? "Publishers" : "Readers";
      let team = teams.find((value) => value.name === name);
      if (!team) {
        response = await request(
          route,
          "POST",
          {
            name,
            permission: write ? "write" : "read",
            includes_all_repositories: false,
            can_create_org_repo: false,
            units: ["repo.packages"],
          },
          admin(),
        );
        team = z
          .object({ id: z.number(), name: z.string(), permission: z.string() })
          .loose()
          .parse(await response.json());
      }
      if (team.permission !== (write ? "write" : "read"))
        throw new Error("Package team permission differs from intent");
      await request(`teams/${team.id}/members/${segment(username)}`, "PUT", undefined, admin());
      const membership = await request(
        `orgs/${segment(owner)}/members/${segment(username)}`,
        "GET",
        undefined,
        admin(),
      );
      if (membership.status !== 204)
        throw new Error("Private package membership was not confirmed");
    },
    async gitGrant(repo: ForgeRepository, username: string) {
      await request(
        `${path(repo)}/collaborators/${segment(username)}`,
        "PUT",
        { permission: "read" },
        admin(),
      );
      const response = await request(
        `${path(repo)}/collaborators/${segment(username)}/permission`,
        "GET",
        undefined,
        admin(),
      );
      const observed = z
        .object({ permission: z.string() })
        .loose()
        .parse(await response.json());
      if (observed.permission !== "read")
        throw new Error("Read-only repository grant was not confirmed");
    },
    async issueToken(
      repo: ForgeRepository,
      username: string,
      password: string,
      scope: "git" | "packages" | "publish",
      name: string,
    ) {
      const response = await request(
        `users/${segment(username)}/tokens`,
        "POST",
        {
          name,
          scopes: [
            scope === "git"
              ? "read:repository"
              : scope === "publish"
                ? "write:package"
                : "read:package",
          ],
          ...(scope === "git" ? { repositories: [repo] } : {}),
        },
        `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      );
      if (!response.ok) throw new Error("Machine token was not confirmed");
      return z
        .object({ id: z.number(), sha1: z.string().min(1) })
        .loose()
        .parse(await response.json());
    },
    async revokeMachine(repo: ForgeRepository, owner: string, username: string) {
      // Remove current ACLs, not only the PAT. Existing OCI bearers must lose owner access too.
      await request(
        `${path(repo)}/collaborators/${segment(username)}`,
        "DELETE",
        undefined,
        admin(),
      );
      await request(
        `orgs/${segment(owner)}/members/${segment(username)}`,
        "DELETE",
        undefined,
        admin(),
      );
      const grant = await request(
        `${path(repo)}/collaborators/${segment(username)}/permission`,
        "GET",
        undefined,
        admin(),
      );
      if (grant.ok) {
        const value = z
          .object({ permission: z.string() })
          .loose()
          .parse(await grant.json());
        if (value.permission !== "none") throw new Error("Repository revocation was not confirmed");
      }
      const membership = await request(
        `orgs/${segment(owner)}/members/${segment(username)}`,
        "GET",
        undefined,
        admin(),
      );
      if (membership.status !== 404)
        throw new Error("Package membership revocation was not confirmed");
      await request(
        `admin/users/${segment(username)}`,
        "PATCH",
        { active: false, prohibit_login: true },
        admin(),
      );
    },
    async protectReleaseTags(repo: ForgeRepository) {
      const protections = await request(`${path(repo)}/tag_protections`);
      if (!protections.ok) throw new Error("Release tag protection is unavailable");
      const rules = z
        .array(
          z
            .object({
              name_pattern: z.string(),
              whitelist_usernames: z.array(z.string()).nullable(),
              whitelist_teams: z.array(z.string()).nullable(),
            })
            .loose(),
        )
        .parse(await protections.json());
      const rule = rules.find((value) => value.name_pattern === "v*");
      if (
        rule &&
        (JSON.stringify(rule.whitelist_usernames) !== JSON.stringify([repo.owner]) ||
          (rule.whitelist_teams?.length ?? 0) !== 0)
      )
        throw new Error("Release tag protection differs from Factory ownership");
      if (!rule) {
        const protectedTag = await request(`${path(repo)}/tag_protections`, "POST", {
          name_pattern: "v*",
          whitelist_usernames: [repo.owner],
          whitelist_teams: [],
        });
        if (!protectedTag.ok) throw new Error("Release tag protection was not confirmed");
      }
    },
    async ensureRelease(repo: ForgeRepository, version: string, sha: string, notes: string) {
      const tag = `v${version}`;
      await this.protectReleaseTags(repo);
      const existingTag = await request(`${path(repo)}/tags/${tag}`);
      if (existingTag.ok) {
        const actual = z
          .object({ commit: z.object({ sha: z.string() }).loose() })
          .loose()
          .parse(await existingTag.json());
        if (actual.commit.sha !== sha)
          throw new Error("Existing version identifies another source commit");
      }
      const existing = await request(`${path(repo)}/releases/tags/${tag}`);
      if (existing.ok) {
        const value = z
          .object({ html_url: z.string(), draft: z.boolean(), name: z.string(), body: z.string() })
          .loose()
          .parse(await existing.json());
        const tagResponse = await request(`${path(repo)}/tags/${tag}`);
        const actual = z
          .object({ commit: z.object({ sha: z.string() }).loose() })
          .loose()
          .parse(await tagResponse.json());
        if (
          actual.commit.sha !== sha ||
          value.draft ||
          value.name !== version ||
          value.body !== notes
        )
          throw new Error("Existing release differs from immutable intent");
        return value.html_url;
      }
      const response = await request(`${path(repo)}/releases`, "POST", {
        tag_name: tag,
        target_commitish: sha,
        name: version,
        body: notes,
        draft: false,
        prerelease: false,
      });
      if (!response.ok) throw new Error("Native release was not confirmed");
      const value = z
        .object({ html_url: z.string(), draft: z.boolean(), name: z.string(), body: z.string() })
        .loose()
        .parse(await response.json());
      const tagResponse = await request(`${path(repo)}/tags/${tag}`);
      if (!tagResponse.ok) throw new Error("Release tag readback is unavailable");
      const actual = z
        .object({ commit: z.object({ sha: z.string() }).loose() })
        .loose()
        .parse(await tagResponse.json());
      if (
        actual.commit.sha !== sha ||
        value.draft ||
        value.name !== version ||
        value.body !== notes
      )
        throw new Error("Published source differs from the recorded intent");
      return value.html_url;
    },
    async versionExists(
      owner: string,
      name: string,
      version: string,
      type: "container" | "generic" = "container",
    ) {
      const response = await request(
        `packages/${segment(owner)}/${type}/${segment(name)}/${segment(version)}`,
        "GET",
        undefined,
        admin(),
      );
      return response.status !== 404;
    },
    async genericFile(
      owner: string,
      name: string,
      version: string,
      filename: string,
      username: string,
      token: string,
    ) {
      const response = await request(
        `packages/${segment(owner)}/generic/${segment(name)}/${segment(version)}/files`,
        "GET",
        undefined,
        `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
      );
      if (!response.ok) throw new Error("Expected generic package is unavailable");
      const files = z
        .array(z.object({ name: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).loose())
        .parse(await response.json());
      const file = files.find((value) => value.name === filename);
      if (!file) throw new Error("Expected release file is unavailable");
      return `sha256:${file.sha256}`;
    },
    async manifest(owner: string, name: string, version: string, username: string, token: string) {
      const route = `/v2/${segment(owner)}/${segment(name)}/manifests/${segment(version)}`;
      const auth = await send(
        new URL(
          `/v2/token?service=container_registry&scope=${segment(`repository:${owner}/${name}:pull`)}`,
          origin,
        ),
        {
          headers: {
            authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
          },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!auth.ok) throw new Error("Registry authentication was not confirmed");
      const bearer = z
        .object({ token: z.string() })
        .loose()
        .parse(await auth.json()).token;
      const response = await send(new URL(route, origin), {
        headers: {
          authorization: `Bearer ${bearer}`,
          accept:
            "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error("Expected release artifact is unavailable");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Registry manifest is empty");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 4_194_304) throw new Error("Registry manifest exceeds its bound");
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = Buffer.concat(chunks);
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (response.headers.get("docker-content-digest") !== digest)
        throw new Error("Registry manifest digest mismatch");
      const value = z
        .object({ config: z.object({ mediaType: z.string() }).loose().optional() })
        .loose()
        .parse(JSON.parse(Buffer.from(bytes).toString()));
      return {
        digest,
        helm: value.config?.mediaType === "application/vnd.cncf.helm.config.v1+json",
      };
    },
  };
}
