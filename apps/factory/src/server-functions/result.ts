import { APIRequestError } from "../api-client";
import { plainErrorMessage, sessionExpiredMessage } from "../command-error";

export type ServerResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string };
export type ServerValue<T> =
  Extract<Awaited<T>, { ok: true }> extends { value: infer V } ? V : never;

// A failed transport never retries a command or reloads the page automatically.
export async function serverCall<T>(call: Promise<ServerResult<T>>): Promise<T> {
  let result: ServerResult<T>;
  try {
    result = await call;
  } catch (cause) {
    if (
      cause &&
      typeof cause === "object" &&
      "unknownFunction" in cause &&
      cause.unknownFunction === true
    )
      throw new APIRequestError(
        409,
        "Factory was updated. Reload before continuing. An unconfirmed command is not repeated.",
      );
    if (cause && typeof cause === "object" && "status" in cause && cause.status === 401)
      throw new APIRequestError(401, sessionExpiredMessage);
    if (cause instanceof Error && plainErrorMessage(cause.message) !== cause.message)
      throw new APIRequestError(503, plainErrorMessage(cause.message));
    throw cause;
  }
  if (!result.ok) throw new APIRequestError(result.status, plainErrorMessage(result.message));
  return result.value;
}
