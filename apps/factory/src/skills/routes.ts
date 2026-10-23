import { z } from "zod";
import {
  skillLibrarySaveInput,
  skillChoiceInput,
} from "../../../../packages/conversation-domain/src/skill-library";
import {
  skillPublishInput,
  skillRoleInput,
  systemSkillSettingsInput,
} from "../../../../packages/conversation-domain/src/skills";
import { json } from "../http";
import type { createSkillController } from "./controller";
import {
  projectSkillSettingsInput,
  personalSkillSettingsInput,
} from "../../../../packages/conversation-domain/src/skill-inheritance";

export function createSkillRoutes(skills: ReturnType<typeof createSkillController>) {
  return async (request: Request, userID: string): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname;
    const projectId = new URL(request.url).searchParams.get("project") ?? undefined;
    if (projectId && !z.uuid().safeParse(projectId).success)
      return json({ error: "Invalid Project" }, 400);
    const invocations = path.match(/^\/api\/projects\/([0-9a-f-]{36})\/skills\/invocations$/);
    if (invocations?.[1]) {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      const query = new URL(request.url).searchParams;
      const role = skillRoleInput.safeParse(query.get("role"));
      const change = query.get("change") ?? undefined;
      if (!role.success || (change && !z.uuid().safeParse(change).success))
        return json({ error: "Invalid Skill work context" }, 400);
      return json(await skills.invocations(invocations[1], userID, role.data, change));
    }
    if (path === "/api/skills/import/preview" || path === "/api/skills/import/repository") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      try {
        return json(
          await skills.library.preview(await request.json(), userID, path.endsWith("/repository")),
        );
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : "Could not preview import" },
          400,
        );
      }
    }
    if (path === "/api/skills") {
      if (request.method === "GET") return json(await skills.getLibrary(userID, projectId));
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const input = skillLibrarySaveInput.safeParse(await request.json().catch(() => null));
      if (!input.success)
        return json({ error: input.error.issues[0]?.message ?? "Invalid skill" }, 400);
      return json(await skills.library.save(input.data, userID), 201);
    }
    if (path === "/api/skills/choices") {
      if (request.method !== "PUT") return new Response(null, { status: 405 });
      const input = skillChoiceInput.safeParse(await request.json().catch(() => null));
      if (!input.success) return json({ error: "Invalid skill choice" }, 400);
      return json(await skills.chooseLibrary(input.data, userID, input.data.projectId));
    }
    if (path === "/api/skills/share") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const input = z
        .object({
          id: z.uuid(),
          revisionId: z.uuid(),
          target: z.enum(["project", "system"]),
          projectId: z.uuid().optional(),
        })
        .strict()
        .safeParse(await request.json().catch(() => null));
      if (!input.success) return json({ error: "Invalid sharing proposal" }, 400);
      return json(
        await skills.library.propose(
          input.data.id,
          input.data.revisionId,
          input.data.target,
          input.data.projectId,
          userID,
        ),
        201,
      );
    }
    const accept = path.match(/^\/api\/skills\/share\/([0-9a-f-]{36})\/accept$/);
    if (accept?.[1]) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      return json(await skills.library.accept(accept[1], userID));
    }
    const inspect = path.match(/^\/api\/skills\/revisions\/([0-9a-f-]{36})$/);
    const updates = path.match(/^\/api\/skills\/revisions\/([0-9a-f-]{36})\/source-update$/);
    if (updates?.[1]) {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      return json(await skills.library.checkSource(updates[1], userID, projectId));
    }
    if (inspect?.[1]) {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      return json(await skills.library.inspect(inspect[1], userID, projectId));
    }
    const project = path.match(
      /^\/api\/projects\/([0-9a-f-]{36})\/skill-settings(?:\/(personal))?$/,
    );
    if (project?.[1]) {
      if (request.method === "GET" && !project[2])
        return json(await skills.getInherited(project[1], userID));
      if (request.method !== "PUT") return new Response(null, { status: 405 });
      const body: unknown = await request.json().catch(() => null);
      if (project[2]) {
        const input = personalSkillSettingsInput.safeParse(body);
        if (!input.success) return json({ error: "Personal Skill settings are invalid" }, 400);
        return json(await skills.setPersonal(project[1], userID, input.data));
      }
      const input = projectSkillSettingsInput.safeParse(body);
      if (!input.success) return json({ error: "Project Skill settings are invalid" }, 400);
      return json(await skills.setProject(project[1], userID, input.data));
    }
    if (path === "/api/admin/skills") {
      if (request.method === "GET") return json(await skills.getSystem(userID));
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const input = skillPublishInput.safeParse(await request.json().catch(() => null));
      if (!input.success) return json({ error: "Skill publication is invalid" }, 400);
      return json(await skills.publish(input.data, userID), 201);
    }
    if (path === "/api/admin/skills/settings") {
      if (request.method !== "PUT") return new Response(null, { status: 405 });
      const input = systemSkillSettingsInput.safeParse(await request.json().catch(() => null));
      if (!input.success) return json({ error: "Skill role settings are invalid" }, 400);
      return json(await skills.setSystem(input.data, userID));
    }
    const publication = path.match(/^\/api\/admin\/skills\/([0-9a-f-]{36})\/publication$/);
    if (!publication?.[1]) return undefined;
    if (request.method !== "PUT") return new Response(null, { status: 405 });
    const input = z
      .object({ published: z.boolean() })
      .strict()
      .safeParse(await request.json().catch(() => null));
    if (!input.success) return json({ error: "Skill publication state is invalid" }, 400);
    return json(await skills.setPublication(publication[1], input.data.published, userID));
  };
}
