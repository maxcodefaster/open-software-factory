import type { createDatabase } from "../../../../packages/db/src/client";
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
      const rows = await database.client<Array<{ desktopBackgroundKey: string }>>`
        SELECT desktop_background_key AS "desktopBackgroundKey"
        FROM factory.user_ui_preference
        WHERE user_id = ${userID}
      `;
      const key = rows[0]?.desktopBackgroundKey;
      return {
        desktopBackgroundKey: isDesktopBackgroundKey(key) ? key : defaultDesktopBackgroundKey,
      };
    },
  };
}
