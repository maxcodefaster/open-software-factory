import { getQuery } from "@rocicorp/zero";
import { handleQueryRequest, PushProcessor } from "@rocicorp/zero/server";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import type { createDatabase } from "../../../../packages/db/src/client";
import { zeroQueries, zeroSchema } from "../../../../packages/zero-schema/src";
import { zeroServerMutators } from "../../../../packages/zero-schema/src/server";
import { createAccessController } from "../access/api";

type Database = ReturnType<typeof createDatabase>;
type Session = { user: { id: string } };
const createProvider = (db: Database["db"]) => zeroDrizzle(zeroSchema, db);
const providers = new WeakMap<Database["db"], ReturnType<typeof createProvider>>();

export function zeroDatabase(database: Database) {
  let provider = providers.get(database.db);
  if (!provider) {
    provider = createProvider(database.db);
    providers.set(database.db, provider);
  }
  return provider;
}

export async function handleZeroQuery(
  request: Request,
  database: Database,
  session: Session | null,
) {
  if (!session) return Response.json({ error: "Authentication required" }, { status: 401 });
  const systemManager = await createAccessController(database).isSystemManager(session.user.id);
  const result = await handleQueryRequest({
    schema: zeroSchema,
    request,
    userID: session.user.id,
    handler(name, args) {
      const query = getQuery(zeroQueries, name);
      if (!query) throw new Error(`Unknown Zero query ${name}`);
      return query.fn({ args, ctx: { userId: session.user.id, systemManager } });
    },
  });
  return Response.json(result);
}

export async function handleZeroMutate(
  request: Request,
  database: Database,
  session: Session | null,
) {
  if (!session) return Response.json({ error: "Authentication required" }, { status: 401 });
  const result = await new PushProcessor(zeroDatabase(database), {
    userId: session.user.id,
  }).process(zeroServerMutators, request);
  return Response.json(result);
}
