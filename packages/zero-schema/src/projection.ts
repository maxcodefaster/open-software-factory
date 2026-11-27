import { boolean, enumeration, number, string } from "@rocicorp/zero";
import { drizzleZeroConfig } from "drizzle-zero";
import {
  epic,
  knowledgePage,
  knowledgePageOutline,
  project,
  projectMembership,
  readVersion,
  ticket,
  ticketDependency,
} from "#db/schema";
import type { DesktopBackgroundKey } from "#interface-domain/background";

// Build-time allowlist. Source provenance, credentials and execution rows never enter Zero.
const tables = drizzleZeroConfig(
  {
    project,
    projectMembership,
    ticket,
    epic,
    ticketDependency,
    knowledgePage,
    knowledgePageOutline,
    readVersion,
  },
  {
    suppressDefaultsWarning: true,
    tables: {
      project: {
        id: true,
        slug: true,
        name: true,
        desktopBackgroundKey: enumeration<DesktopBackgroundKey>().from("desktop_background_key"),
        repositoryUrl: true,
        defaultBranch: true,
        actorTemplatePath: true,
        createdAt: number().from("created_at"),
        updatedAt: number().from("updated_at"),
      },
      projectMembership: {
        projectId: true,
        userId: true,
        role: enumeration<"developer" | "product-contributor">(),
        manageProject: boolean().from("manage_project"),
      },
      ticket: {
        id: true,
        projectId: true,
        epicId: true,
        title: true,
        description: string(),
        state: enumeration<"inbox" | "backlog" | "ready" | "in-progress" | "cancelled" | "done">(),
        version: number(),
        createdBy: true,
        createdAt: number().from("created_at"),
        updatedAt: number().from("updated_at"),
        trashedAt: true,
        convertedToEpicId: true,
        trashStopPending: boolean().from("trash_stop_pending").optional(),
        trashError: true,
      },
      epic: {
        id: true,
        projectId: true,
        parentId: true,
        title: true,
        description: string(),
        version: number(),
        createdBy: true,
        createdAt: number().from("created_at"),
        updatedAt: number().from("updated_at"),
      },
      ticketDependency: {
        projectId: true,
        ticketId: true,
        prerequisiteId: true,
        createdBy: true,
        createdAt: number().from("created_at"),
      },
      knowledgePage: {
        id: true,
        projectId: true,
        slug: true,
        title: true,
        parentId: true,
        sortOrder: number().from("sort_order"),
        icon: enumeration<"knowledge" | "home" | "ticket" | "ide" | "preview" | "settings">(),
        metadataVersion: number().from("metadata_version"),
        state: enumeration<"active" | "archived">(),
        version: number(),
        currentBody: true,
        currentRevisionId: true,
        createdAt: number().from("created_at"),
        updatedAt: number().from("updated_at"),
      },
      knowledgePageOutline: {
        id: true,
        projectId: true,
        slug: true,
        title: true,
        parentId: true,
        sortOrder: number().from("sort_order"),
        icon: enumeration<"knowledge" | "home" | "ticket" | "ide" | "preview" | "settings">(),
        metadataVersion: number().from("metadata_version"),
        state: enumeration<"active" | "archived">(),
        version: number(),
        currentRevisionId: true,
        createdAt: number().from("created_at"),
        updatedAt: number().from("updated_at"),
      },
      readVersion: {
        projectId: true,
        audience: true,
        scope: enumeration<
          | "lifecycle"
          | "ticket"
          | "conversation"
          | "review"
          | "inbox"
          | "knowledge"
          | "inputs"
          | "sources"
          | "releases"
        >(),
        resourceId: true,
        revision: string(),
      },
    },
  },
);

const members = [
  {
    sourceField: ["projectId"],
    destField: ["projectId"],
    destSchema: "projectMembership",
    cardinality: "many",
  },
] as const;

// Authorization joins are deliberate product queries, not inferred foreign-key relationships.
export const schema = {
  ...tables,
  relationships: {
    project: { members: [{ ...members[0], sourceField: ["id"] }] },
    ticket: {
      members,
      dependents: [
        {
          sourceField: ["id"],
          destField: ["prerequisiteId"],
          destSchema: "ticketDependency",
          cardinality: "many",
        },
      ],
    },
    epic: { members },
    ticketDependency: { members },
    knowledgePage: { members },
    knowledgePageOutline: { members },
    readVersion: { members },
  },
} as const;
