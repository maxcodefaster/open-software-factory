type FollowableMessage = {
  id: string;
  activity?:
    | {
        name: string;
        status: string;
        navigation?: { path: string; diff?: string | undefined } | undefined;
      }
    | undefined;
};

export type FollowTarget = { path: string; line?: number };

const editTools = new Set(["write", "edit", "apply_patch"]);

/** The first line a unified diff adds or changes in the new file, when the diff says so. */
export function firstChangedLine(diff: string | undefined) {
  if (!diff) return undefined;
  let line: number | undefined;
  for (const text of diff.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) {
      line = Number(header[1]);
      continue;
    }
    if (line === undefined) continue;
    if (text.startsWith("+") && !text.startsWith("+++")) return line;
    if (!text.startsWith("-") && !text.startsWith("\\")) line += 1;
  }
  return undefined;
}

/**
 * Picks the one file edit worth following. The first look at a conversation only records what is
 * already there, so opening the IDE never replays history. Later it returns the newest edit that
 * has not been offered yet and skips the ones before it, so a burst of edits moves the editor once.
 */
export function createAgentFollower() {
  let scope: string | undefined;
  let primed = false;
  const offered = new Set<string>();
  return {
    next(changeID: string | undefined, messages: readonly FollowableMessage[]) {
      if (scope !== changeID) {
        scope = changeID;
        primed = false;
        offered.clear();
      }
      const fresh: Array<{ key: string; target: FollowTarget }> = [];
      for (const message of messages) {
        const activity = message.activity;
        const navigation = activity?.navigation;
        if (
          !activity ||
          !navigation ||
          !editTools.has(activity.name) ||
          activity.status === "error"
        )
          continue;
        const line = firstChangedLine(navigation.diff);
        const key = `${message.id}:${line ?? ""}`;
        if (offered.has(key)) continue;
        offered.add(key);
        fresh.push({ key, target: { path: navigation.path, ...(line ? { line } : {}) } });
      }
      if (!primed) {
        primed = true;
        return undefined;
      }
      return fresh.at(-1)?.target;
    },
  };
}
