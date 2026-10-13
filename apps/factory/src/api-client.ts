import { z } from "zod";

const errorResponseSchema = z.object({ error: z.string().optional() });

export async function apiRequest<TSchema extends z.ZodType>(
  schema: TSchema,
  path: string,
  options?: RequestInit,
): Promise<z.output<TSchema>> {
  const response = await fetch(path, options);
  const value = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = errorResponseSchema.safeParse(value);
    throw new Error(
      error.success && error.data.error
        ? error.data.error
        : `Request failed with ${response.status}`,
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      "Factory returned an unexpected response. Retry, or reload Factory if this continues.",
    );
  return parsed.data;
}

export const emptyResponseSchema = z.unknown();
