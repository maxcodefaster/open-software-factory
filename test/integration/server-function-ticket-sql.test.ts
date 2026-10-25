import { expect, test } from "bun:test";
import { decodeResponse } from "@solidjs/web/server-functions/client";
import { createAccessController } from "../../apps/factory/src/access/controller";
import { createTicketService } from "../../apps/factory/src/change/service";
import { createTicketDocumentController } from "../../apps/factory/src/change/document";
import { createTicketTrashController } from "../../apps/factory/src/change/trash";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { serverCall, type ServerResult } from "../../apps/factory/src/server-functions/result";
import { compiledFactoryEndpoint, factoryFunctionRequest } from "../fixtures/server-functions";
import { factoryProcess } from "../fixtures/factory-process";

test("native Ticket document writes preserve CAS, exact retries, retained history, Trash and current Project authority", async () => {
  const host = await factoryProcess(),
    database = host.connect();
  const actor = crypto.randomUUID(),
    outsider = crypto.randomUUID(),
    project = crypto.randomUUID(),
    ticket = crypto.randomUUID(),
    origin = "https://owned-ticket-sql.test";
  let authenticated = true,
    maintenance = false,
    inference = 0;
  const trash = createTicketTrashController(
    database,
    {
      stop: async () => {
        throw new Error("This proof owns no runtime");
      },
    },
    {
      stop: async () => {
        throw new Error("This proof owns no Agent");
      },
    },
    {
      stopForTrash: async () => {
        throw new Error("This proof owns no Verification");
      },
    },
  );
  const endpoint = await compiledFactoryEndpoint({
    origin,
    session: async (request) =>
      authenticated ? { user: { id: request.headers.get("x-owned-actor") ?? actor } } : null,
    maintenance: async () => maintenance,
    requireFresh: async () => {},
    services: {
      tickets: createTicketService({
        database,
        access: createAccessController(database),
        documents: createTicketDocumentController(database),
        trash,
        changes: {
          async createRevision() {
            throw new Error("Not used by this document proof");
          },
          async approve() {
            throw new Error("Not used by this document proof");
          },
          async start() {
            inference++;
            throw new Error("Saving must not commission implementation");
          },
        },
        agent: {
          async admitStartIn() {
            inference++;
            throw new Error("Saving must not admit a turn");
          },
        },
      }),
    } as unknown as FactoryServices,
  });
  const call = async <T>(name: string, args: unknown[], user = actor, signal?: AbortSignal) => {
    const result = await decodeResponse<ServerResult<T>>(
      await endpoint(
        await factoryFunctionRequest(origin, name, args, { "x-owned-actor": user }, signal),
      ),
    );
    if (!result) throw new Error("Owned Ticket function returned no result");
    return serverCall(Promise.resolve(result));
  };
  try {
    for (const id of [actor, outsider])
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${id},'Owned document author',${`${id}@ticket-sql.test`},true)`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${project},${`ticket-sql-${project}`},'Owned ticket','https://example.invalid/owned.git','main','.devcontainer/devcontainer.json',${actor})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
      VALUES(${project},${actor},'product-contributor',${actor})`;
    await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by) VALUES(${ticket},${project},'Owned intent','ready',${actor})`;
    const input = {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      expectedDocumentId: null,
      requirementRevisionId: null,
      title: "Exact human intent",
      description: "No automatic inference",
      requirement: {
        summary: "A complete specification",
        acceptanceCriteria: ["Keep exact text"],
        nonGoals: [],
      },
    };
    maintenance = true;
    await expect(call("saveTicketDocument", [ticket, input])).rejects.toMatchObject({
      status: 503,
    });
    maintenance = false;
    await expect(call("getTicketDetail", [ticket], outsider)).rejects.toMatchObject({
      status: 404,
    });
    const saved = await call<{
      id: string;
      ticketVersion: number;
      requirementRevisionId: string | null;
    }>("saveTicketDocument", [ticket, input]);
    expect(saved).toEqual({
      id: input.commandId,
      ticketVersion: 2,
      requirementRevisionId: input.commandId,
    });
    // Throw away the first acknowledgement; observing and retrying the same
    // identity must not duplicate a revision or change the admitted input.
    expect(await call("saveTicketDocument", [ticket, input])).toEqual(saved);
    await expect(
      call("saveTicketDocument", [ticket, { ...input, description: "Changed replay" }]),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      call("saveTicketDocument", [ticket, { ...input, commandId: crypto.randomUUID() }]),
    ).rejects.toMatchObject({ status: 409 });
    const detail = await call<
      Awaited<ReturnType<ReturnType<typeof createTicketService>["detail"]>>
    >("getTicketDetail", [ticket]);
    expect(detail.ticket).toMatchObject({ id: ticket, title: input.title, version: 2 });
    expect(detail.documentRevisions).toHaveLength(1);
    expect(detail.documentRevisions[0]).toMatchObject({
      id: input.commandId,
      authorKind: "human",
      requirementRevisionId: input.commandId,
    });
    expect(typeof detail.documentRevisions[0]?.createdAt).toBe("string");
    await call("trashTicket", [ticket]);
    await expect(call("restoreTicket", [ticket, 2])).rejects.toMatchObject({ status: 409 });
    const [trashed] = await database.client<
      { version: number }[]
    >`SELECT version::int FROM factory.ticket WHERE id=${ticket}`;
    if (!trashed) throw new Error("Owned Ticket missing");
    // Its own empty cleanup settles without any runtime resources.
    for (let read = 0; read < 50; read++) {
      const [row] = await database.client<
        { pending: boolean }[]
      >`SELECT trash_stop_pending AS pending FROM factory.ticket WHERE id=${ticket}`;
      if (!row?.pending) break;
      await Bun.sleep(10);
    }
    await call("restoreTicket", [ticket, trashed.version]);
    const [retained] =
      await database.client`SELECT title,trashed_at FROM factory.ticket WHERE id=${ticket}`;
    expect(retained).toMatchObject({ title: input.title, trashed_at: null });
    await database.client`DELETE FROM factory.project_membership WHERE project_id=${project} AND user_id=${actor}`;
    await expect(call("getTicketDetail", [ticket])).rejects.toMatchObject({ status: 404 });
    await expect(call("saveTicketDocument", [ticket, input])).rejects.toMatchObject({
      status: 404,
    });
    expect(
      await database.client`SELECT id FROM factory.ticket_document_revision WHERE ticket_id=${ticket}`,
    ).toHaveLength(1);
    expect(
      await database.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${ticket}`,
    ).toHaveLength(0);
    expect(inference).toBe(0);
    authenticated = false;
    expect(
      (await endpoint(await factoryFunctionRequest(origin, "getTicketDetail", [ticket]))).status,
    ).toBe(401);
  } finally {
    trash.close();
    await database.client.end();
    await host.dispose();
  }
}, 60_000);
