import { describe, expect, test } from "bun:test";
import type { RepositoryMirror } from "#project-domain/repository-mirror";
import {
  clearMirrorToken,
  confirmingRemoteName,
  describeMirrorStatus,
  emptyMirrorDraft,
  formatMirrorTimestamp,
  isMirrorBusy,
  mirrorActionError,
  mirrorActionNotice,
} from "./mirror-state";

describe("repository mirror state machine", () => {
  test("derives busy, error, notice and confirming remote from MirrorActionState", () => {
    expect(isMirrorBusy({ kind: "idle" })).toBe(false);
    expect(isMirrorBusy({ kind: "syncing" })).toBe(true);
    expect(isMirrorBusy({ kind: "removing", remoteName: "origin-mirror" })).toBe(true);
    expect(isMirrorBusy({ kind: "confirming-remove", remoteName: "origin-mirror" })).toBe(false);
    expect(confirmingRemoteName({ kind: "confirming-remove", remoteName: "r1" })).toBe("r1");
    expect(confirmingRemoteName({ kind: "removing", remoteName: "r1" })).toBe("r1");
    expect(confirmingRemoteName({ kind: "idle" })).toBeUndefined();
    expect(mirrorActionError({ kind: "idle", error: "err" })).toBe("err");
    expect(mirrorActionNotice({ kind: "confirming-remove", remoteName: "r1", notice: "ok" })).toBe(
      "ok",
    );
  });

  test("clears credentials from draft and formats mirror status/timestamp", () => {
    const draft = { ...emptyMirrorDraft(true), target: "https://example.com/a.git", token: "sec" };
    expect(clearMirrorToken(draft)).toEqual({ ...draft, token: "" });
    expect(formatMirrorTimestamp(null)).toBe("No attempt observed");

    const base: RepositoryMirror = {
      remoteName: "mirror-1",
      targetURL: "https://example.com/a.git",
      syncOnCommit: true,
      interval: "1h0m0s",
      branchFilter: "",
      lastAttempt: null,
      failed: false,
    };
    expect(describeMirrorStatus(base)).toBe("No successful synchronization confirmed yet.");
    expect(describeMirrorStatus({ ...base, lastAttempt: "2026-01-01T00:00:00Z" })).toBe(
      "Last observed attempt succeeded.",
    );
    expect(
      describeMirrorStatus({ ...base, lastAttempt: "2026-01-01T00:00:00Z", failed: true }),
    ).toBe("Last attempt failed. Check the target's access and protection rules.");
  });
});
