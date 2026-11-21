export type RuntimeProcessSnapshot = {
  name: string;
  label?: string;
  state: "starting" | "running" | "stopping" | "stopped" | "failed";
  output: string;
  startedAt?: string;
  exitCode?: number;
};
