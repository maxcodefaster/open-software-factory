import { expect, test } from "bun:test";
import { createProjectAppPreviews } from "../../apps/factory/src/access/previews";
import { createKnowledgeController } from "../../apps/factory/src/knowledge/controller";
import { createProjectService } from "../../apps/factory/src/projects/service";
import { factoryProcess } from "../fixtures/factory-process";

test("Project public Forge source is admitted and read through its private API without runtime or inference", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const userID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const revision = "a".repeat(40);
  const publicURL = "https://git.owned-source.invalid";
  const calls: string[] = [];
  let knowledge: ReturnType<typeof createKnowledgeController> | undefined;
  const forge = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe("Bearer owned-source-reader-token");
      const url = new URL(request.url);
      calls.push(url.pathname);
      if (url.pathname === "/api/v1/repos/owned/app/branches/main")
        return Response.json({ name: "main", commit: { id: revision } });
      expect(url.pathname).toBe("/api/v1/repos/owned/app/contents/.factory/system.json");
      expect(url.searchParams.get("ref")).toBe(revision);
      return Response.json({
        encoding: "base64",
        sha: "b".repeat(40),
        content: Buffer.from(
          JSON.stringify({
            version: 1,
            primaryApp: "web",
            apps: [
              {
                id: "web",
                label: "Owned website",
                command: ["node", "server.mjs"],
                port: 4300,
                healthPath: "/",
              },
            ],
          }),
        ).toString("base64"),
      });
    },
  });
  const configuration = {
    FACTORY_FORGEJO_API_URL: `${forge.url}api/v1/`,
    FACTORY_FORGEJO_PUBLIC_URL: publicURL,
    FACTORY_FORGEJO_TOKEN: "owned-source-reader-token",
    FACTORY_FORGEJO_OWNER: "owned",
  };
  const previous = new Map(Object.keys(configuration).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, configuration);
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${userID},'Owned source reader',${`${userID}@factory.invalid`})`;
    await database.client`INSERT INTO factory.project(
      id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${projectID},${`source-${projectID}`},'Owned source',
        ${`${publicURL}/owned/app.git`},'main','.devcontainer/devcontainer.json',${userID})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${projectID},${userID},'product-contributor',${userID})`;
    await database.client`INSERT INTO factory.project_setup_readiness(project_id,task,state,command_id)
      VALUES(${projectID},'configuration','ready',${crypto.randomUUID()})`;
    const previews = createProjectAppPreviews(database, () => {
      throw Error("Source discovery cannot require or commission a Connector");
    });
    expect(await previews(projectID, userID)).toEqual([
      {
        projectID,
        channel: "app",
        label: "Staging · Owned website",
        port: 4300,
        state: "not-started",
      },
    ]);
    expect(calls).toEqual([
      "/api/v1/repos/owned/app/branches/main",
      "/api/v1/repos/owned/app/contents/.factory/system.json",
    ]);
    const knowledgeReads: string[] = [];
    knowledge = createKnowledgeController(
      database,
      {
        getDefaultBranch: async (repository) => {
          expect(repository).toEqual({ owner: "owned", name: "app" });
          knowledgeReads.push("branch");
          return { name: "main", headSha: revision };
        },
        listFiles: async (repository, ref) => {
          expect(repository).toEqual({ owner: "owned", name: "app" });
          expect(ref).toBe(revision);
          knowledgeReads.push("tree");
          return [{ path: "README.md", sha: "c".repeat(40), size: 12 }];
        },
        getFileInfo: async (repository, path, ref) => {
          expect(repository).toEqual({ owner: "owned", name: "app" });
          expect(path).toBe("README.md");
          expect(ref).toBe(revision);
          knowledgeReads.push("file");
          return { sha: "c".repeat(40), content: "Owned source" };
        },
      },
      async () => {
        throw Error("Source reads cannot commission Wiki inference");
      },
    );
    expect(await knowledge.documents(projectID)).toMatchObject({
      commitSha: revision,
      documents: [{ path: "README.md", title: "README" }],
    });
    expect(await knowledge.document(projectID, "README.md")).toMatchObject({
      commitSha: revision,
      body: "Owned source",
    });
    for (const source of [
      "https://foreign.invalid/owned/app.git",
      `${publicURL}/foreign/app.git`,
      `${publicURL}/owned/app.git?ref=other`,
      `${publicURL}/owned/app.git#source`,
      `${publicURL}/owned/app.git/`,
    ]) {
      await database.client`UPDATE factory.project SET repository_url=${source} WHERE id=${projectID}`;
      await expect(previews(projectID, userID)).rejects.toThrow("configured Factory Forgejo");
      await expect(knowledge.documents(projectID)).rejects.toThrow("configured Factory Forgejo");
    }
    expect(calls).toHaveLength(2);
    expect(knowledgeReads).toEqual(["branch", "tree", "branch", "file"]);
    const administrator = crypto.randomUUID();
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${administrator},'Owned registration authority',${`${administrator}@factory.invalid`})`;
    await database.client`INSERT INTO factory.administrator(user_id) VALUES(${administrator})`;
    let registrations = 0;
    const projects = createProjectService({
      database,
      localRepositoryOrigin: forge.url.origin,
      publicRepositoryOrigin: publicURL,
      forgeOwner: "owned",
      onRegistered: async () => {
        registrations++;
      },
    });
    const registration = {
      name: "Owned public source",
      slug: `public-${projectID}`,
      repositoryUrl: `${publicURL}/owned/registered.git`,
      defaultBranch: "main",
      devcontainerPath: ".devcontainer/devcontainer.json",
    };
    await expect(projects.register(userID, registration)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(registrations).toBe(0);
    expect(await projects.register(administrator, registration)).toMatchObject({
      repositoryUrl: registration.repositoryUrl,
    });
    expect(registrations).toBe(1);
    await expect(
      projects.register(administrator, {
        ...registration,
        slug: `foreign-${projectID}`,
        repositoryUrl: "https://foreign.invalid/owned/registered.git",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(registrations).toBe(1);
    expect(
      await database.client`SELECT id FROM factory.runtime_attempt
      WHERE project_id=${projectID}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.agent_turn
      WHERE project_id=${projectID}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT project_id FROM factory.staging_preview
      WHERE project_id=${projectID}`,
    ).toHaveLength(0);
  } finally {
    await knowledge?.close();
    for (const [key, value] of previous)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await forge.stop(true);
    await database.client.end({ timeout: 0 });
    await host.dispose();
  }
});
