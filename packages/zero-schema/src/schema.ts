import {
  boolean,
  createBuilder,
  createSchema,
  enumeration,
  number,
  relationships,
  string,
  table,
} from "@rocicorp/zero";
import type { DesktopBackgroundKey } from "../../interface-domain/src/background";

const project = table("project")
  .from("factory.project")
  .columns({
    id: string(),
    slug: string(),
    name: string(),
    desktopBackgroundKey: enumeration<DesktopBackgroundKey>().from("desktop_background_key"),
    repositoryUrl: string().from("repository_url"),
    defaultBranch: string().from("default_branch"),
    devcontainerPath: string().from("devcontainer_path"),
    createdAt: number().from("created_at"),
    updatedAt: number().from("updated_at"),
  })
  .primaryKey("id");

const projectMembership = table("projectMembership")
  .from("factory.project_membership")
  .columns({
    projectId: string().from("project_id"),
    userId: string().from("user_id"),
    role: enumeration<"developer" | "product-contributor">(),
    manageProject: boolean().from("manage_project"),
  })
  .primaryKey("projectId", "userId");

const ticket = table("ticket")
  .from("factory.ticket")
  .columns({
    id: string(),
    projectId: string().from("project_id"),
    epicId: string().from("epic_id").optional(),
    title: string(),
    description: string(),
    state: enumeration<"inbox" | "backlog" | "ready" | "in-progress" | "cancelled" | "done">(),
    version: number(),
    createdBy: string().from("created_by"),
    createdAt: number().from("created_at"),
    updatedAt: number().from("updated_at"),
    trashedAt: number().from("trashed_at").optional(),
    convertedToEpicId: string().from("converted_to_epic_id").optional(),
    trashStopPending: boolean().from("trash_stop_pending").optional(),
    trashError: string().from("trash_error").optional(),
  })
  .primaryKey("id");

const epic = table("epic")
  .from("factory.epic")
  .columns({
    id: string(),
    projectId: string().from("project_id"),
    parentId: string().from("parent_id").optional(),
    title: string(),
    description: string(),
    version: number(),
    createdBy: string().from("created_by"),
    createdAt: number().from("created_at"),
    updatedAt: number().from("updated_at"),
  })
  .primaryKey("id");

const ticketDependency = table("ticketDependency")
  .from("factory.ticket_dependency")
  .columns({
    projectId: string().from("project_id"),
    ticketId: string().from("ticket_id"),
    prerequisiteId: string().from("prerequisite_id"),
    createdBy: string().from("created_by"),
    createdAt: number().from("created_at"),
  })
  .primaryKey("projectId", "ticketId", "prerequisiteId");

const knowledgePage = table("knowledgePage")
  .from("factory.knowledge_page")
  .columns({
    id: string(),
    projectId: string().from("project_id"),
    slug: string(),
    title: string(),
    parentId: string().from("parent_id").optional(),
    sortOrder: number().from("sort_order"),
    icon: enumeration<"knowledge" | "home" | "ticket" | "ide" | "preview" | "settings">(),
    metadataVersion: number().from("metadata_version"),
    state: enumeration<"active" | "archived">(),
    version: number(),
    currentBody: string().from("current_body"),
    currentRevisionId: string().from("current_revision_id").optional(),
    createdAt: number().from("created_at"),
    updatedAt: number().from("updated_at"),
  })
  .primaryKey("id");

export const zeroSchema = createSchema({
  tables: [project, ticket, epic, ticketDependency, knowledgePage, projectMembership],
  relationships: [
    relationships(project, ({ many }) => ({
      members: many({
        sourceField: ["id"],
        destField: ["projectId"],
        destSchema: projectMembership,
      }),
    })),
    relationships(ticket, ({ many }) => ({
      members: many({
        sourceField: ["projectId"],
        destField: ["projectId"],
        destSchema: projectMembership,
      }),
    })),
    relationships(epic, ({ many }) => ({
      members: many({
        sourceField: ["projectId"],
        destField: ["projectId"],
        destSchema: projectMembership,
      }),
    })),
    relationships(ticketDependency, ({ many }) => ({
      members: many({
        sourceField: ["projectId"],
        destField: ["projectId"],
        destSchema: projectMembership,
      }),
    })),
    relationships(knowledgePage, ({ many }) => ({
      members: many({
        sourceField: ["projectId"],
        destField: ["projectId"],
        destSchema: projectMembership,
      }),
    })),
  ],
  enableLegacyQueries: false,
  enableLegacyMutators: false,
});

export const zql = createBuilder(zeroSchema);
export type FactoryZeroSchema = typeof zeroSchema;
export interface FactoryZeroContext {
  readonly userId: string;
  readonly systemManager?: boolean;
}
