import {
  type TurnUsage,
  turnUsageInput,
  unavailableTurnUsage,
} from "../../../../packages/conversation-domain/src/turn-usage";

// Ephemeral observations, not accounting records. A restart/expiry means unknown, not zero.
export function createUsageObservations(now: () => number = Date.now) {
  const observations = new Map<string, { usage: TurnUsage; expires: number }>();
  function prune() {
    for (const [id, value] of observations) {
      if (value.expires <= now()) observations.delete(id);
    }
  }
  return {
    record(id: string, usage: TurnUsage) {
      prune();
      observations.delete(id);
      observations.set(id, { usage: turnUsageInput.parse(usage), expires: now() + 30 * 60_000 });
      if (observations.size > 128) {
        const oldest = observations.keys().next().value;
        if (oldest !== undefined) observations.delete(oldest);
      }
    },
    get(id: string) {
      prune();
      return observations.get(id)?.usage ?? unavailableTurnUsage();
    },
  };
}
