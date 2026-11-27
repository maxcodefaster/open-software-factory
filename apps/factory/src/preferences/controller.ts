import { and, eq } from "drizzle-orm";
import type { createDatabase } from "#db/client";
import { operation } from "#db/schema";
import {
  type DesktopBackgroundKey,
  defaultDesktopBackgroundKey,
  isDesktopBackgroundKey,
} from "#interface-domain/background";

const UI_PREFERENCE_KIND = "user.ui_preference";

export type UIPreference = {
  desktopBackgroundKey: DesktopBackgroundKey;
};

export function createUIPreferenceController(database: ReturnType<typeof createDatabase>) {
  return {
    async get(userID: string): Promise<UIPreference> {
      const rows = await database.db
        .select({ payload: operation.payload })
        .from(operation)
        .where(
          and(
            eq(operation.kind, UI_PREFERENCE_KIND),
            eq(operation.scopeType, "user"),
            eq(operation.scopeId, userID),
            eq(operation.idempotencyKey, `${UI_PREFERENCE_KIND}:${userID}`),
          ),
        );
      const key = rows[0]?.payload["desktopBackgroundKey"];
      return {
        desktopBackgroundKey: isDesktopBackgroundKey(key) ? key : defaultDesktopBackgroundKey,
      };
    },
  };
}
