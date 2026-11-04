export type WikiRole = "planner" | "plan-checker" | "investigator" | "writer" | "checker";

type Tally = { runs: number; steps: number; toolRounds: number; ms: number; pausedMs: number };

const roleOf: Record<string, WikiRole> = {
  "topic-planner": "planner",
  "topic-plan-checker": "plan-checker",
  investigator: "investigator",
  writer: "writer",
  checker: "checker",
};
export const wikiRole = (agent: string): WikiRole => roleOf[agent] ?? "writer";

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * Counters and timings for one Wiki generation. They hold numbers and Factory-owned labels only,
 * never model prose, so they can go to the log and the persisted progress.
 */
export function createWikiMetrics(clock: () => number = () => performance.now()) {
  const roles = new Map<WikiRole, Tally>();
  const stages = new Map<string, Map<string, number>>();
  const started = clock();
  const tally = (role: WikiRole) => {
    let value = roles.get(role);
    if (!value) {
      value = { runs: 0, steps: 0, toolRounds: 0, ms: 0, pausedMs: 0 };
      roles.set(role, value);
    }
    return value;
  };
  return {
    /** One agent run. step() counts each provider request; wait() the time a 429 pause cost. */
    begin(agent: string) {
      const total = tally(wikiRole(agent));
      const begun = clock();
      total.runs++;
      return {
        step(toolCalls: number) {
          total.steps++;
          if (toolCalls > 0) total.toolRounds++;
        },
        wait(ms: number) {
          total.pausedMs += ms;
        },
        end() {
          total.ms += clock() - begun;
        },
      };
    },
    stage(scope: string, name: string, ms: number) {
      let topic = stages.get(scope);
      if (!topic) {
        topic = new Map();
        stages.set(scope, topic);
      }
      topic.set(name, (topic.get(name) ?? 0) + ms);
    },
    totals() {
      let modelSteps = 0,
        toolRounds = 0,
        pausedMs = 0;
      for (const value of roles.values()) {
        modelSteps += value.steps;
        toolRounds += value.toolRounds;
        pausedMs += value.pausedMs;
      }
      return { modelSteps, toolRounds, pausedMs: Math.round(pausedMs) };
    },
    elapsedMs: () => clock() - started,
    stageSeconds: (scope: string, name: string) => seconds(stages.get(scope)?.get(name) ?? 0),
    roleLines() {
      return [...roles.entries()].map(
        ([role, value]) =>
          `${role} runs=${value.runs} steps=${value.steps} toolRounds=${value.toolRounds} busy=${seconds(value.ms)} paused=${seconds(value.pausedMs)}`,
      );
    },
    topicLine(scope: string, extra: string) {
      const parts = [...(stages.get(scope) ?? new Map<string, number>()).entries()].map(
        ([name, ms]) => `${name}=${seconds(ms)}`,
      );
      return `topic ${scope} ${extra} ${parts.join(" ")}`.trim();
    },
  };
}
export type WikiMetrics = ReturnType<typeof createWikiMetrics>;
