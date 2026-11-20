import { eq } from "drizzle-orm";
import type { createDatabase } from "../../../../packages/db/src/client";
import { userUIPreference } from "../../../../packages/db/src/schema";
import {
  type DesktopBackgroundKey,
  defaultDesktopBackgroundKey,
  isDesktopBackgroundKey,
} from "../../../../packages/interface-domain/src/background";

export type UIPreference = {
  desktopBackgroundKey: DesktopBackgroundKey;
};

export function createUIPreferenceController(database: ReturnType<typeof createDatabase>) {
  return {
    async get(userID: string): Promise<UIPreference> {
      const rows = await database.db
        .select({ desktopBackgroundKey: userUIPreference.desktopBackgroundKey })
        .from(userUIPreference)
        .where(eq(userUIPreference.userId, userID));
      const key = rows[0]?.desktopBackgroundKey;
      return {
        desktopBackgroundKey: isDesktopBackgroundKey(key) ? key : defaultDesktopBackgroundKey,
      };
    },
  };
}
