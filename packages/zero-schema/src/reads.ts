import { defineQueryWithType } from "@rocicorp/zero";
import { z } from "zod";
import { type FactoryZeroContext, type FactoryZeroSchema, zql } from "./schema";

const defineQuery = defineQueryWithType<FactoryZeroSchema, FactoryZeroContext>();
const scope = z.enum([
  "lifecycle",
  "ticket",
  "conversation",
  "review",
  "inbox",
  "knowledge",
  "inputs",
  "sources",
  "releases",
]);

function readableVersions(ctx: FactoryZeroContext) {
  const query = zql.readVersion;
  if (ctx.systemManager) return query.where("audience", "IN", ["shared", "developer", ctx.userId]);
  return query
    .whereExists("members", (member) => member.where("userId", ctx.userId))
    .where(({ cmp, or, and, exists }) =>
      or(
        cmp("audience", "shared"),
        cmp("audience", ctx.userId),
        and(
          cmp("audience", "developer"),
          exists("members", (member) =>
            member.where("userId", ctx.userId).where("role", "developer"),
          ),
        ),
      ),
    );
}

export const readVersionQueries = {
  list: defineQuery(
    z.union([
      z.strictObject({ scope: z.literal("inbox") }),
      z.strictObject({ projectId: z.uuid(), scope, resourceId: z.uuid() }),
    ]),
    ({ args, ctx }) =>
      "projectId" in args
        ? readableVersions(ctx)
            .where("projectId", args.projectId)
            .where("scope", args.scope)
            .where("resourceId", args.resourceId)
        : readableVersions(ctx).where("scope", "inbox"),
  ),
};
