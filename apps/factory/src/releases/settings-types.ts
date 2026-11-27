import type { ReleaseSettingsView } from "#project-domain/release";

export type Release = ReleaseSettingsView["releases"][number];
export type ReleaseGrant = ReleaseSettingsView["access"][number];
export type ReleasePanel = "versions" | "access";

export type ReleaseDialog =
  | { kind: "none" }
  | {
      kind: "confirm-publish";
      version: string;
      commitSHA: string;
      notes: string;
      commandID: string;
    }
  | { kind: "confirm-end"; releaseID: string }
  | { kind: "confirm-rotate"; grantID: string; commandID: string }
  | { kind: "confirm-revoke"; grantID: string }
  | { kind: "show-credential"; username: string; token: string | null; revealed: boolean };

export type ReleaseCommandState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "error"; message: string }
  | { kind: "notice"; message: string };

export type AccessCommand = { commandID: string; name: string; scope: "git" | "packages" };

const stateLabels: Record<Release["state"], string> = {
  pending: "Queued",
  dispatching: "Starting",
  running: "Building artifacts",
  checking: "Checking artifacts",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
  uncertain: "Outcome unconfirmed",
};

export const releaseStatus = (release: Release) =>
  `${release.endedAt ? "Ended · " : ""}${stateLabels[release.state]}`;

export const releaseDateLabel = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

export function focusDecision(trigger: HTMLElement) {
  const entry = trigger.closest("li");
  queueMicrotask(() => {
    const decision = entry?.querySelector<HTMLElement>(".release-confirmation");
    decision?.querySelector<HTMLElement>("h4")?.focus();
    decision?.scrollIntoView({ block: "nearest" });
  });
}
