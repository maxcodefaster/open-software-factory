import type { VisualReview } from "#conversation-domain/visual-review";
import { getRetainedReviewView, type PanelReviewCapture } from "./panel-state";

export function readVideoMetrics(
  video: HTMLVideoElement | undefined,
  recording: VisualReview["recording"] | undefined,
) {
  return {
    ratio: video?.videoHeight ? video.videoWidth / video.videoHeight : undefined,
    duration:
      video && Number.isFinite(video.duration)
        ? video.duration
        : (recording?.durationMs ?? 0) / 1000,
  };
}

export function restoreRetainedPlayhead(
  video: HTMLVideoElement | undefined,
  viewKey: string,
  recordingID: string | undefined,
) {
  const retained = getRetainedReviewView(viewKey);
  if (
    video &&
    retained &&
    retained.recordingID === recordingID &&
    Number.isFinite(video.duration) &&
    Math.abs(video.currentTime - retained.time) > 0.05
  )
    video.currentTime = Math.min(retained.time, video.duration);
}

export async function captureRecordingFrame(options: {
  video: HTMLVideoElement | undefined;
  player: HTMLDivElement | undefined;
  recording: VisualReview["recording"] | undefined;
  currentRecordingID: () => string | undefined;
  hasDraftBody: boolean;
  onOpenComposer: () => void;
  onCapturedFrame: (capture: PanelReviewCapture) => void;
  onError: (message: string) => void;
}) {
  if (document.fullscreenElement === options.player)
    await document.exitFullscreen().catch(() => {});
  if (options.hasDraftBody) {
    options.onOpenComposer();
    return;
  }
  const { video, recording } = options;
  if (!video || !recording || recording.state !== "complete") return;
  video.pause();
  const source = video.currentSrc;
  if (video.seeking) {
    const ready = await new Promise<boolean>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        video.removeEventListener("seeked", done);
        resolve(false);
      }, 5_000);
      video.addEventListener("seeked", done, { once: true });
    });
    if (!ready) {
      options.onError("This frame did not load. Seek again before annotating.");
      return;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  if (!canvas.width || !canvas.height) {
    options.onError("Wait for the video to load before annotating.");
    return;
  }
  if (options.currentRecordingID() !== recording.id || video.currentSrc !== source) {
    options.onError("The QA recording changed. Choose a frame from the current recording.");
    return;
  }
  canvas.getContext("2d")?.drawImage(video, 0, 0);
  const timestampMs = Math.round(video.currentTime * 1000);
  const frame = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.88),
  );
  if (!frame) return;
  options.onCapturedFrame({
    id: crypto.randomUUID(),
    frame,
    context: { source: "recording", recordingId: recording.id, timestampMs },
    timestampMs,
    page: `QA ${recording.commitSha.slice(0, 8)}`,
  });
}
