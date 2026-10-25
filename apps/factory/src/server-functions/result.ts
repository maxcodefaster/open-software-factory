import { APIRequestError } from "../api-client";

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
    throw cause;
  }
  if (!result.ok) throw new APIRequestError(result.status, result.message);
  return result.value;
}
