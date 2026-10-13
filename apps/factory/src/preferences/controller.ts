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

    async set(userID: string, desktopBackgroundKey: DesktopBackgroundKey): Promise<UIPreference> {
      const rows = await database.client<Array<{ desktopBackgroundKey: DesktopBackgroundKey }>>`
        INSERT INTO factory.user_ui_preference(user_id, desktop_background_key)
        VALUES (${userID}, ${desktopBackgroundKey})
        ON CONFLICT (user_id) DO UPDATE SET
          desktop_background_key = EXCLUDED.desktop_background_key,
          updated_at = now()
        RETURNING desktop_background_key AS "desktopBackgroundKey"
      `;
      const preference = rows[0];
      if (!preference) throw new Error("UI Preference update returned no row");
      return preference;
    },
  };
}
