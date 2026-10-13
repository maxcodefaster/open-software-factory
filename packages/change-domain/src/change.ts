import { createHash } from "node:crypto";

export const changeStates = [
  "branch-pending",
  "starting",
  "active",
  "cancelling",
  "cancelled",
  "failed",
  "delivering",
  "delivered",
] as const;
export type ChangeState = (typeof changeStates)[number];

export function changeIdentity(ticketID: string, requirementApprovalID: string) {
  const digest = createHash("sha256").update(`${ticketID}:${requirementApprovalID}`).digest("hex");
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return {
    changeID: id,
    branchName: `factory/change-${digest.slice(0, 12)}`,
    branchOperationID: `${digest.slice(32, 40)}-${digest.slice(40, 44)}-5${digest.slice(45, 48)}-8${digest.slice(49, 52)}-${digest.slice(52, 64)}`,
  };
}
