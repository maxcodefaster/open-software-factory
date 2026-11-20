import { createBuilder } from "@rocicorp/zero";
import { schema } from "./schema.generated";

export const zeroSchema = schema;
export const zql = createBuilder(zeroSchema);
export type FactoryZeroSchema = typeof zeroSchema;
export interface FactoryZeroContext {
  readonly userId: string;
  readonly systemManager?: boolean;
}
