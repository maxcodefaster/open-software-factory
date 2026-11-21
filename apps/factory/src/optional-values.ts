import { z } from "zod";

export const optionalString = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().optional(),
);

export const optionalNumber = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.number().optional(),
);

export function optionalEnum<const TValues extends readonly [string, ...string[]]>(
  values: TValues,
) {
  return z.preprocess((value) => (value === null ? undefined : value), z.enum(values).optional());
}
