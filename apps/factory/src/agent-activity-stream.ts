import { type Observation, observeAgentStream } from "./agent/observe-stream";
import { getAgentActivity } from "./server-functions/agent";
import { serverCall } from "./server-functions/result";

export function observeAgentActivity(options: Observation & { changeID: string }) {
  // Only the named read reconnects. No execution command enters this loop.
  return observeAgentStream(options, (signal) =>
    serverCall(getAgentActivity({ ...{ signal }, data: [options.changeID] })),
  );
}
