import { z } from "zod";
import { SystemContractError } from "../../../../../packages/system-contract/src/system-contract";
import { CommandError } from "../../command-error";
import { json } from "../../http";
import { appTimeoutResponse } from "../../runtime/app-timeout";

export function protocolFailure(request: Request, cause: unknown): Response {
  if (cause instanceof CommandError)
    return json({ error: cause.message, code: cause.code }, cause.status);
  if (cause instanceof z.ZodError)
    return json({ error: "Invalid command. Check the entered values." }, 400);
  console.error(cause);
  if (cause instanceof SystemContractError) return json({ error: cause.message }, 422);
  return appTimeoutResponse(request, cause) ?? json({ error: "Factory command failed" }, 500);
}
