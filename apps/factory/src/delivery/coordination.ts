import type { z } from "zod";
import { deliveryDelegationInput } from "../../../../packages/change-domain/src/delivery";
import type { createDatabase } from "../../../../packages/db/src/client";
import { projectAuthorityIn, projectDevelopmentAuthorityIn } from "../access/controller";
import type { AgentTurnTransaction } from "../agent/turn-store";
import { CommandError } from "../command-error";

export async function deliveryDelegationIn(
  sql: AgentTurnTransaction,
  projectID: string,
  policyID: string,
) {
  const [policy] = await sql<{ userID: string }[]>`SELECT delegated_by AS "userID"
    FROM factory.project_delivery_policy WHERE id=${policyID} AND project_id=${projectID} AND revoked_at IS NULL FOR SHARE`;
  if (!policy)
    throw new CommandError("forbidden", "Automatic Delivery delegation is no longer active.");
  await projectAuthorityIn(sql, policy.userID, projectID, true);
  await projectDevelopmentAuthorityIn(sql, policy.userID, projectID);
  return policy.userID;
}

export function createDeliveryCoordination(database: ReturnType<typeof createDatabase>) {
  return {
    async claim(projectID: string, changeID: string) {
      return database.client.begin(async (sql) => {
        await sql`INSERT INTO factory.project_delivery_queue(project_id) VALUES(${projectID}) ON CONFLICT DO NOTHING`;
        const [slot] = await sql<{ changeID: string | null }[]>`SELECT change_id AS "changeID"
          FROM factory.project_delivery_queue WHERE project_id=${projectID} FOR UPDATE`;
        const [promotion] = await sql<{ changeID: string }[]>`SELECT merge.change_id AS "changeID"
          FROM factory.merge_operation merge JOIN factory.change change ON change.id=merge.change_id
          LEFT JOIN factory.promotion_operation promotion ON promotion.change_id=change.id
          WHERE change.project_id=${projectID} AND merge.state<>'failed'
            AND (merge.state<>'succeeded' OR promotion.state IS NULL OR promotion.state<>'succeeded')
          ORDER BY merge.id LIMIT 1`;
        if (promotion && promotion.changeID !== changeID) return false;
        if (slot?.changeID && slot.changeID !== changeID) {
          const [blocked] = await sql`SELECT change.id FROM factory.change change
            JOIN factory.ticket ticket ON ticket.id=change.ticket_id
            LEFT JOIN factory.change_agent_session session ON session.change_id=change.id
            LEFT JOIN factory.agent_turn turn ON turn.id=session.active_turn_id
            LEFT JOIN factory.change_writer writer ON writer.change_id=change.id
            WHERE change.id=${slot.changeID} AND (
              change.state IN ('cancelled','cancelling','failed','delivered') OR ticket.trashed_at IS NOT NULL
              OR change.delivery_waiting_sha=(SELECT commit_sha FROM factory.change_commit_operation
                WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1)
              OR session.stop_pending OR session.state IN ('failed','stopped','waiting')
              OR (session.state IN ('starting','working') AND turn.authority->'review' IS NULL)
              OR writer.state IN ('human','handoff') OR EXISTS(
                SELECT 1 FROM factory.review_feedback WHERE change_id=change.id AND kind='thread' AND state<>'resolved'))`;
          if (!blocked) return false;
        }
        await sql`UPDATE factory.project_delivery_queue SET change_id=${changeID},updated_at=now()
          WHERE project_id=${projectID} AND change_id IS DISTINCT FROM ${changeID}::uuid`;
        return true;
      });
    },
    async release(changeID: string) {
      await database.client`UPDATE factory.project_delivery_queue SET change_id=NULL,updated_at=now()
        WHERE change_id=${changeID} AND NOT EXISTS(
          SELECT 1 FROM factory.merge_operation merge LEFT JOIN factory.promotion_operation promotion ON promotion.change_id=merge.change_id
          WHERE merge.change_id=${changeID} AND merge.state<>'failed'
            AND (merge.state<>'succeeded' OR promotion.state IS NULL OR promotion.state<>'succeeded'))`;
    },
    async activePolicy(projectID: string) {
      const [policy] = await database.client<
        { id: string; userID: string }[]
      >`SELECT id,delegated_by AS "userID"
        FROM factory.project_delivery_policy WHERE project_id=${projectID} AND revoked_at IS NULL`;
      if (!policy) return null;
      try {
        await database.client.begin((sql) => deliveryDelegationIn(sql, projectID, policy.id));
        return policy;
      } catch (cause) {
        if (cause instanceof CommandError) return null;
        throw cause;
      }
    },
    async settings(projectID: string, userID: string) {
      const canManage = await database.client.begin((sql) =>
        projectAuthorityIn(sql, userID, projectID),
      );
      let canDelegate = canManage;
      try {
        await database.client.begin((sql) => projectDevelopmentAuthorityIn(sql, userID, projectID));
      } catch (cause) {
        if (!(cause instanceof CommandError)) throw cause;
        canDelegate = false;
      }
      const [policy] = await database.client<
        { id: string; delegatedBy: string }[]
      >`SELECT id,delegated_by AS "delegatedBy"
        FROM factory.project_delivery_policy WHERE project_id=${projectID} AND revoked_at IS NULL`;
      const active = await this.activePolicy(projectID);
      return {
        policyId: policy?.id ?? null,
        enabled: Boolean(active),
        delegatedBy: policy?.delegatedBy ?? null,
        canManage,
        canDelegate,
      };
    },
    async configure(
      projectID: string,
      userID: string,
      raw: z.input<typeof deliveryDelegationInput>,
    ) {
      const input = deliveryDelegationInput.parse(raw);
      await database.client.begin(async (sql) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`delivery-policy:${projectID}`}))`;
        await projectAuthorityIn(sql, userID, projectID, true);
        if (input.enabled) await projectDevelopmentAuthorityIn(sql, userID, projectID);
        const [current] = await sql<{ id: string }[]>`SELECT id FROM factory.project_delivery_policy
          WHERE project_id=${projectID} AND revoked_at IS NULL FOR UPDATE`;
        if (input.enabled && current?.id === input.commandId) return;
        if (!input.enabled && !current && input.expectedPolicyId) {
          const [replay] = await sql`SELECT id FROM factory.project_delivery_policy
            WHERE id=${input.expectedPolicyId} AND project_id=${projectID}
              AND revoked_command_id=${input.commandId} AND revoked_by=${userID}`;
          if (replay) return;
        }
        if ((current?.id ?? null) !== input.expectedPolicyId)
          throw new CommandError(
            "conflict",
            "Delivery delegation changed. Refresh before changing it.",
          );
        if (current)
          await sql`UPDATE factory.project_delivery_policy SET revoked_at=now(),revoked_command_id=${input.commandId},revoked_by=${userID} WHERE id=${current.id}`;
        if (input.enabled)
          await sql`INSERT INTO factory.project_delivery_policy(id,project_id,delegated_by)
            VALUES(${input.commandId},${projectID},${userID})`;
      });
      return this.settings(projectID, userID);
    },
  };
}
