import { z } from "zod";

const errorResponseSchema = z.object({ error: z.string().optional() });

export class APIRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "APIRequestError";
  }
}

function parseResponse<TSchema extends z.ZodType>(
  schema: TSchema,
  status: number,
  value: unknown,
): z.output<TSchema> {
  if (status < 200 || status >= 300) {
    const error = errorResponseSchema.safeParse(value);
    throw new APIRequestError(
      status,
      error.success && error.data.error ? error.data.error : `Request failed with ${status}`,
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      "Factory returned an unexpected response. Retry, or reload Factory if this continues.",
    );
  return parsed.data;
}

type JSONProtocolPath =
  | "/api/auth/sign-out"
  | "/api/auth/sign-in/sso"
  | `/api/changes/${string}/review/stills`;

// Better Auth owns its session protocol; still images use multipart bytes.
// Product reads and commands must use named Server Functions instead.
export async function protocolRequest<TSchema extends z.ZodType>(
  schema: TSchema,
  path: JSONProtocolPath,
  options?: RequestInit,
): Promise<z.output<TSchema>> {
  if (
    path !== "/api/auth/sign-out" &&
    path !== "/api/auth/sign-in/sso" &&
    !/^\/api\/changes\/[0-9a-f-]{36}\/review\/stills$/.test(path)
  )
    throw new Error("Unclassified browser HTTP operation. Use a named Server Function.");
  const response = await fetch(path, options);
  const value = await response.json().catch(() => undefined);
  return parseResponse(schema, response.status, value);
}

// XHR exposes actual transfer completion separately from the server's processing response.
// This makes no retries. Only raw Attachment bytes use this authenticated PUT.
export function apiUpload<TSchema extends z.ZodType>(
  schema: TSchema,
  path: string,
  options: {
    body: ArrayBuffer;
    mediaType: string;
    onProgress(loaded: number, total: number): void;
    onTransferred(): void;
  },
): Promise<z.output<TSchema>> {
  if (!/^\/api\/attachments\/[^/?#]+$/.test(path))
    return Promise.reject(new Error("Only raw Attachment uploads use this HTTP protocol."));
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", path);
    request.setRequestHeader("content-type", options.mediaType);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) options.onProgress(event.loaded, event.total);
    };
    request.upload.onload = () => options.onTransferred();
    request.onload = () => {
      try {
        let value: unknown;
        try {
          value = JSON.parse(request.responseText);
        } catch {
          /* The shared response validator reports invalid or unconfirmed outcomes. */
        }
        resolve(parseResponse(schema, request.status, value));
      } catch (cause) {
        reject(cause);
      }
    };
    const uncertain = () =>
      reject(new APIRequestError(0, "Upload confirmation was lost. Retry the same file request."));
    request.onerror = uncertain;
    request.onabort = uncertain;
    request.ontimeout = uncertain;
    request.send(options.body);
  });
}

export const emptyResponseSchema = z.unknown();
