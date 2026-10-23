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

export async function apiRequest<TSchema extends z.ZodType>(
  schema: TSchema,
  path: string,
  options?: RequestInit,
): Promise<z.output<TSchema>> {
  const response = await fetch(path, options);
  const value = await response.json().catch(() => undefined);
  return parseResponse(schema, response.status, value);
}

// XHR exposes actual transfer completion separately from the server's processing response.
// This makes no retries and keeps the same authenticated PUT and response contract as apiRequest.
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
