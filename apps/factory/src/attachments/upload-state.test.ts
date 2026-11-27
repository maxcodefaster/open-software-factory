import { describe, expect, test } from "bun:test";
import {
  createUploadDraftRegistry,
  detectAttachmentFileType,
  draftError,
  draftRetryFiles,
  draftStatus,
  formatFileSize,
  formatPrivacyNotice,
  formatSelectionSummary,
  formatSizeRestrictions,
  isDraftBusy,
} from "./upload-state";

describe("attachment upload state machine", () => {
  test("manages UploadPhase transitions in draft registry", () => {
    const registry = createUploadDraftRegistry();
    expect(isDraftBusy(registry.get("k"))).toBe(false);
    expect(draftError(registry.get("k"))).toBe("");
    expect(draftRetryFiles(registry.get("k"))).toEqual([]);

    registry.update("k", { phase: { kind: "uploading", status: "Uploading a.png…" } });
    expect(isDraftBusy(registry.get("k"))).toBe(true);
    expect(draftStatus(registry.get("k"), false)).toBe("Uploading a.png…");

    const retryFile = new File(["x"], "a.png", { type: "image/png" });
    registry.update("k", {
      phase: { kind: "retryable", error: "Upload failed.", retryFiles: [retryFile] },
    });
    expect(isDraftBusy(registry.get("k"))).toBe(false);
    expect(draftError(registry.get("k"))).toBe("Upload failed.");
    expect(draftRetryFiles(registry.get("k"))).toEqual([retryFile]);

    registry.clear("k");
    expect(draftError(registry.get("k"))).toBe("");
  });

  test("formats file sizes, media types, limits, privacy notices and summaries", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2 KiB");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2 MiB");
    expect(detectAttachmentFileType(new File(["x"], "spec.md"))).toBe("text/markdown");
    expect(detectAttachmentFileType(new File(["x"], "archive.zip"))).toBeUndefined();

    expect(formatSizeRestrictions({ kind: "loading" }, true)).toBe(" · Loading size limits…");
    expect(formatSizeRestrictions({ kind: "unavailable" }, true)).toBe(
      " · Size limits unavailable",
    );
    expect(
      formatSizeRestrictions(
        {
          kind: "ready",
          limits: { fileBytes: 5 * 1024 * 1024, messageBytes: 10 * 1024 * 1024 },
        },
        true,
      ),
    ).toBe(" · 5 MiB per file · 10 MiB total");

    expect(formatPrivacyNotice(undefined, "draft-1")).toBe(
      "New files stay private until this Ticket is created.",
    );
    expect(
      formatSelectionSummary({
        count: 0,
        queuedCount: 2,
        uploaded: [],
        limitsState: { kind: "loading" },
        sizeRestrictions: " · Loading size limits…",
      }),
    ).toBe("2 ready to attach");
  });
});
