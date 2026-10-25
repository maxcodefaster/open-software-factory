import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { z } from "zod";
import {
  feedbackCreateInput,
  feedbackDispatchInput,
  feedbackUpdateInput,
  pendingReviewThreads,
  type ReviewFeedback,
  reviewRegion,
  type VisualReview,
} from "../../../../packages/conversation-domain/src/visual-review";
import { APIRequestError } from "../api-client";
import { attachmentText, readAttachmentContent } from "../attachments/composer";
import { TextareaAttachments } from "../attachments/ui";
import { Icon } from "../icon";
import { markdownHTML } from "../markdown";
import { bindPopoverKeyboard } from "../popover-keyboard";
import { serverCall } from "../server-functions/result";
import {
  createReviewFeedback,
  getVisualReview,
  sendReviewRevision,
  updateReviewFeedback,
} from "../server-functions/review";
import { TicketActionBar } from "../ticket-action-bar";
import { ReviewComposer } from "./composer";
import { reviewMediaURL, uploadReviewStill } from "./media-client";
import { reviewTime, scenarioAt } from "./playback";
import { ReviewPlayerControls } from "./player-controls";
import "./review.css";

const pendingCommand = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("feedback"), input: feedbackCreateInput }),
  z.strictObject({ action: z.literal("update"), input: feedbackUpdateInput }),
  z.strictObject({ action: z.literal("send"), input: feedbackDispatchInput }),
]);

export type ReviewRevisionAction = {
  count: number;
  disabled: boolean;
  sending: boolean;
  request(): void;
};

export type ReviewActions = {
  revision: ReviewRevisionAction | undefined;
  addFeedback: (() => void) | undefined;
  reload(): void;
};

export function ReviewThreadStatus(props: { count: number }) {
  return (
    <span class="review-thread-count" role="status">
      {props.count
        ? `${props.count} open ${props.count === 1 ? "Thread blocks" : "Threads block"} Delivery`
        : "No open Threads"}
    </span>
  );
}

export type ReviewCapture = {
  id: string;
  frame?: Blob;
  documentId?: string;
  selector?: string;
  context:
    | { source: "recording"; recordingId: string; timestampMs: number }
    | { source: "preview"; attemptId: string; representation?: "dom-reconstruction" };
  page: string;
  element?: string;
  timestampMs?: number;
  region?: z.infer<typeof reviewRegion>;
};
// Navigation state only. Preserve a draft and playhead when the Ticket view
// unmounts to show another Factory tab; it never admits work or changes provenance.
const retainedReviewViews = new Map<
  string,
  {
    body: string;
    kind: "comment" | "thread";
    capture?: ReviewCapture | undefined;
    time: number;
    recordingID?: string;
    scenario: string;
    composing: boolean;
    marking: boolean;
    position: { x: number; y: number };
    replies: Record<string, string>;
  }
>();

export function ReviewPanel(props: {
  changeID: string;
  userID: string;
  canDevelop: boolean;
  readOnly?: boolean;
  capture?: ReviewCapture | undefined;
  onCaptureCleared?: () => void;
  onThreadCount?: (count: number) => void;
  compact?: boolean;
  viewID?: string;
  feedbackID?: string | undefined;
  active?: boolean | undefined;
  onFeedback?(feedback: ReviewFeedback[], readOnly: boolean): void;
  onDraftChange?(dirty: boolean): void;
  onClose?(): void;
  onOpenPreview?: (() => void) | undefined;
  onActions?(actions: ReviewActions | undefined): void;
}) {
  const [view, setView] = createSignal<VisualReview>();
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [body, setBody] = createSignal("");
  const [kind, setKind] = createSignal<"comment" | "thread">("comment");
  const [replies, setReplies] = createSignal<Record<string, string>>({});
  const [capture, setCapture] = createSignal<ReviewCapture>();
  const [frameURL, setFrameURL] = createSignal("");
  const capturedBlob = createMemo(() => capture()?.frame);
  const [selectedScenario, setSelectedScenario] = createSignal("");
  const [videoReady, setVideoReady] = createSignal(false);
  const [videoFailed, setVideoFailed] = createSignal(false);
  const [playhead, setPlayhead] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [paused, setPaused] = createSignal(true);
  const [fullscreen, setFullscreen] = createSignal(false);
  const [videoRatio, setVideoRatio] = createSignal(16 / 9);
  const [captionsURL, setCaptionsURL] = createSignal("");
  const [composing, setComposing] = createSignal(Boolean(props.compact));
  const [markingVideo, setMarkingVideo] = createSignal(false);
  const [composerPosition, setComposerPosition] = createSignal({ x: 12, y: 12 });
  let surface: HTMLElement | undefined;
  let video: HTMLVideoElement | undefined;
  let player: HTMLDivElement | undefined;
  let restoredRecording: string | undefined;
  let generation = 0;
  let inFlight = false;
  let readSequence = 0;
  let pendingRead: Promise<void> | undefined;
  let retry: z.infer<typeof pendingCommand> | undefined;
  const commandKey = () => `factory:visual-review:${props.userID}:${props.changeID}:command`;
  const viewKey = () =>
    `${props.userID}:${props.changeID}:${props.compact ? (props.viewID ?? "preview") : "ticket"}`;
  const mediaURL = (id: string) => reviewMediaURL(props.changeID, id);
  const readOnly = () => Boolean(props.readOnly || view()?.readOnly);
  createEffect(
    () => body(),
    (value) => {
      props.onDraftChange?.(Boolean(value.trim()));
    },
  );
  const visibleFeedback = () =>
    view()?.feedback.filter((item) => !props.compact || item.id === props.feedbackID) ?? [];
  const scopeIdentity = createMemo(viewKey);
  const recordingIdentity = createMemo(() => view()?.recording?.id);
  const recordingSource = createMemo(() => {
    const id = recordingIdentity();
    return id ? mediaURL(id) : undefined;
  });
  function refresh(fresh = false): Promise<void> {
    // A slow read must still be publishable when the next poll ticks. Commands
    // and explicit cross-view changes supersede reads begun before their save.
    if (pendingRead && !fresh) return pendingRead;
    const epoch = generation;
    const sequence = ++readSequence;
    const request = (async () => {
      let result: VisualReview;
      try {
        result = await serverCall(getVisualReview(props.changeID));
      } catch (cause) {
        if (epoch === generation && sequence === readSequence && !view()) setLoadFailed(true);
        throw cause;
      }
      if (epoch !== generation || sequence !== readSequence) return;
      setLoadFailed(false);
      setView(result);
      props.onThreadCount?.(
        result.feedback.filter((item) => item.kind === "thread" && item.state !== "resolved")
          .length,
      );
      props.onFeedback?.(result.feedback, Boolean(result.readOnly));
    })();
    pendingRead = request;
    const settled = () => {
      if (pendingRead === request) pendingRead = undefined;
    };
    void request.then(settled, settled);
    return request;
  }
  createEffect(scopeIdentity, () => {
    const key = viewKey();
    const scopeGeneration = ++generation;
    pendingRead = undefined;
    retry = undefined;
    inFlight = false;
    setBusy(false);
    setView(undefined);
    setLoadFailed(false);
    setBody("");
    setKind("comment");
    setReplies({});
    setCapture(undefined);
    setSelectedScenario("");
    setComposing(Boolean(props.compact));
    setMarkingVideo(false);
    setError("");
    setNotice("");
    const retained = retainedReviewViews.get(viewKey());
    if (retained) {
      setBody(retained.body);
      setKind(retained.kind);
      setCapture(retained.capture);
      setSelectedScenario(retained.scenario);
      setComposing(retained.composing);
      setMarkingVideo(retained.marking);
      setComposerPosition(retained.position);
      setReplies(retained.replies);
    }
    try {
      const stored = sessionStorage.getItem(commandKey());
      if (stored) {
        retry = pendingCommand.parse(JSON.parse(stored));
        if (retry.action === "feedback") {
          setBody(retry.input.body);
          setKind(retry.input.kind);
        }
        setError(
          "An earlier save is unconfirmed. Check the latest review, then retry the same saved request. No work starts automatically.",
        );
      }
    } catch {
      setError(
        "A saved review request could not be restored. Check the coding history before sending a new correction.",
      );
    }
    void refresh().catch(() => {
      if (generation === scopeGeneration)
        setError("Review could not load. Reload review to retry.");
    });
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === props.changeID && props.active !== false)
        void refresh(true).catch(() => {});
    };
    window.addEventListener("factory-review-changed", changed);
    const timer = setInterval(() => {
      if (props.active !== false && document.visibilityState !== "hidden")
        void refresh().catch(() => {});
    }, 5_000);
    return () => {
      retainedReviewViews.set(key, {
        body: body(),
        kind: kind(),
        ...(capture() ? { capture: capture() } : {}),
        time: video?.currentTime ?? 0,
        ...(view()?.recording?.id ? { recordingID: view()!.recording!.id } : {}),
        scenario: selectedScenario(),
        composing: composing(),
        marking: markingVideo(),
        position: composerPosition(),
        replies: replies(),
      });
      generation++;
      video?.pause();
      clearInterval(timer);
      window.removeEventListener("factory-review-changed", changed);
    };
  });
  createEffect(
    () => props.capture,
    (value) => {
      if (value) {
        setCapture(value);
        setComposing(true);
        setNotice("");
      }
    },
  );
  createEffect(
    () => props.feedbackID,
    () => {
      setNotice("");
    },
  );
  createEffect(capturedBlob, (value) => {
    if (!value) {
      setFrameURL("");
      return;
    }
    const url = URL.createObjectURL(value);
    setFrameURL(url);
    return () => URL.revokeObjectURL(url);
  });
  createEffect(recordingIdentity, () => {
    setVideoReady(false);
    setVideoFailed(false);
    setPaused(true);
    setDuration(0);
    restoredRecording = undefined;
  });
  const captionPayload = createMemo(() =>
    JSON.stringify({
      scenarios: view()?.scenarios ?? [],
      duration: view()?.recording?.durationMs ?? 0,
    }),
  );
  createEffect(captionPayload, (value) => {
    const { scenarios, duration } = JSON.parse(value) as {
      scenarios: VisualReview["scenarios"];
      duration: number;
    };
    const time = (milliseconds: number) => {
      const total = Math.max(0, Math.round(milliseconds));
      return `${String(Math.floor(total / 3_600_000)).padStart(2, "0")}:${String(Math.floor(total / 60_000) % 60).padStart(2, "0")}:${String(Math.floor(total / 1_000) % 60).padStart(2, "0")}.${String(total % 1_000).padStart(3, "0")}`;
    };
    const text = (input: string) =>
      input
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\n\n", "\n");
    const cues = scenarios
      .filter(
        (scenario) =>
          scenario.observationKind !== "source" && scenario.hasRecordingPosition !== false,
      )
      .map(
        (scenario) =>
          `${time(scenario.startedMs)} --> ${time(Math.max(scenario.startedMs + 1, scenario.endedMs ?? duration))}\n${text([scenario.title, scenario.expected ? `Expected: ${scenario.expected}` : "", scenario.observed ? `Observed: ${scenario.observed}` : ""].filter(Boolean).join("\n"))}`,
      );
    const url = URL.createObjectURL(
      new Blob([`WEBVTT\n\n${cues.join("\n\n")}\n`], { type: "text/vtt" }),
    );
    setCaptionsURL(url);
    return () => URL.revokeObjectURL(url);
  });
  createEffect(
    () => props.active,
    (active) => {
      if (active === false) video?.pause();
      else if (props.compact && !props.feedbackID) setComposing(true);
    },
  );
  const pauseHidden = () => {
    if (document.visibilityState === "hidden") video?.pause();
  };
  document.addEventListener("visibilitychange", pauseHidden);
  onCleanup(() => document.removeEventListener("visibilitychange", pauseHidden));
  const fullscreenChanged = () => setFullscreen(document.fullscreenElement === player);
  document.addEventListener("fullscreenchange", fullscreenChanged);
  onCleanup(() => document.removeEventListener("fullscreenchange", fullscreenChanged));

  const syncPlayhead = () => {
    if (!video) return;
    setPlayhead(video.currentTime);
    if (
      video.paused &&
      view()?.scenarios.some(
        (item) =>
          item.id === selectedScenario() &&
          (item.observationKind === "source" || item.hasRecordingPosition === false),
      )
    )
      return;
    setSelectedScenario(scenarioAt(view()?.scenarios ?? [], video.currentTime)?.id ?? "");
  };
  const syncMetadata = () => {
    if (video?.videoHeight) setVideoRatio(video.videoWidth / video.videoHeight);
    setDuration(
      video && Number.isFinite(video.duration)
        ? video.duration
        : (view()?.recording?.durationMs ?? 0) / 1000,
    );
  };
  const seek = (seconds: number) => {
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(duration(), seconds));
    setSelectedScenario("");
    syncPlayhead();
  };
  const togglePlayback = () => {
    if (!video || !duration() || videoFailed()) return;
    if (!video.paused) video.pause();
    else {
      setSelectedScenario(scenarioAt(view()?.scenarios ?? [], video.currentTime)?.id ?? "");
      if (video.ended) seek(0);
      void video.play().catch(() => setError("Playback could not start. Press Play to try again."));
    }
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === player) await document.exitFullscreen();
      else await player?.requestFullscreen();
    } catch {
      setError("Full screen is unavailable. You can still review the recording here.");
    }
  };
  const focusFeedback = async (item: ReviewFeedback) => {
    video?.pause();
    if (document.fullscreenElement === player) await document.exitFullscreen().catch(() => {});
    const annotation = item.annotation;
    if (annotation?.source === "recording" && annotation.recordingId === view()?.recording?.id) {
      video?.pause();
      seek(annotation.timestampMs / 1000);
    }
    const entry = surface?.querySelector<HTMLElement>(`#review-feedback-${item.id}`);
    const fold = entry?.closest<HTMLDetailsElement>(".review-resolved");
    if (fold) fold.open = true;
    entry?.scrollIntoView({ block: "nearest" });
    entry?.focus({ preventScroll: true });
  };

  async function command(action: string, input: unknown) {
    if (inFlight) return false;
    const stored = sessionStorage.getItem(commandKey());
    if (stored && (!retry || stored !== JSON.stringify(retry))) {
      setError(
        "Another review view has an unconfirmed request. Check and retry it there before saving new feedback.",
      );
      return false;
    }
    if (
      retry &&
      (retry.action !== action || JSON.stringify(retry.input) !== JSON.stringify(input))
    ) {
      setError(
        "Check the unconfirmed request first. Only its explicit retry can send that saved request.",
      );
      return false;
    }
    inFlight = true;
    setBusy(true);
    setError("");
    setNotice("");
    const epoch = generation;
    const key = commandKey();
    try {
      retry ??= pendingCommand.parse({ action, input });
      sessionStorage.setItem(key, JSON.stringify(retry));
      const current = retry;
      if (current.action === "feedback")
        await serverCall(createReviewFeedback(props.changeID, current.input));
      else if (current.action === "update")
        await serverCall(updateReviewFeedback(props.changeID, current.input));
      else await serverCall(sendReviewRevision(props.changeID, current.input));
      sessionStorage.removeItem(key);
      if (epoch !== generation) return false;
      retry = undefined;
      if (current.action === "feedback") {
        setBody("");
        setKind("comment");
        setCapture(undefined);
        props.onCaptureCleared?.();
        setComposing(Boolean(props.compact));
        setMarkingVideo(false);
        setNotice("Saved. No agent work has started.");
      } else if (current.action === "send") {
        setNotice("Revision requested. Threads stay open for your recheck.");
      }
      await refresh(true).catch(() => {
        if (epoch === generation)
          setError("Saved, but the latest review could not load. Reload review to refresh it.");
      });
      window.dispatchEvent(new CustomEvent("factory-review-changed", { detail: props.changeID }));
      return true;
    } catch (cause) {
      if (epoch === generation) {
        // A confirmed rejection did not admit work. Unknown transport outcomes
        // keep their exact command identity, including across a page reload.
        if (cause instanceof APIRequestError && cause.status >= 400 && cause.status < 500) {
          retry = undefined;
          sessionStorage.removeItem(key);
          void refresh(true).catch(() => {});
        }
        setError(
          cause instanceof Error ? cause.message : "Review could not save. Retry the same command.",
        );
      }
      return false;
    } finally {
      if (epoch === generation) {
        inFlight = false;
        setBusy(false);
      }
    }
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!body().trim() || inFlight) return;
    const epoch = generation;
    const frozen = capture();
    let annotation: unknown;
    if (frozen && !retry) {
      inFlight = true;
      setBusy(true);
      try {
        let media: { id: string; page?: string | undefined } | undefined;
        if (frozen.frame) {
          try {
            media = await uploadReviewStill(props.changeID, {
              id: frozen.id,
              frame: frozen.frame,
              context: frozen.context,
            });
          } catch (cause) {
            if (frozen.context.source === "recording") throw cause;
            setNotice("Context image could not save. The Preview anchor is retained.");
          }
        }
        if (epoch !== generation) return;
        annotation = {
          source: frozen.context.source,
          ...(media ? { mediaId: media.id } : {}),
          page: media?.page ?? frozen.page,
          ...(frozen.context.source === "preview"
            ? {
                attemptId: frozen.context.attemptId,
                ...(frozen.documentId ? { documentId: frozen.documentId } : {}),
                ...(frozen.selector ? { selector: frozen.selector } : {}),
              }
            : {}),
          ...(frozen.region ? { region: frozen.region } : {}),
          ...(frozen.element ? { element: frozen.element } : {}),
          ...(frozen.timestampMs !== undefined ? { timestampMs: frozen.timestampMs } : {}),
        };
      } catch (cause) {
        if (epoch === generation)
          setError(
            cause instanceof Error
              ? cause.message
              : "Original frame could not save. Your comment is retained.",
          );
        return;
      } finally {
        if (epoch === generation) {
          inFlight = false;
          setBusy(false);
        }
      }
    }
    if (
      await command("feedback", {
        commandId: crypto.randomUUID(),
        kind: kind(),
        body: body(),
        ...(annotation ? { annotation } : {}),
      })
    ) {
      setBody("");
    }
  }
  async function annotateFrame() {
    if (document.fullscreenElement === player) await document.exitFullscreen().catch(() => {});
    if (body().trim()) {
      setComposing(true);
      return;
    }
    const recording = view()?.recording;
    if (!video || !recording || recording.state !== "complete") return;
    video.pause();
    const source = video.currentSrc;
    if (video.seeking) {
      const current = video;
      const ready = await new Promise<boolean>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          current.removeEventListener("seeked", done);
          resolve(false);
        }, 5_000);
        current.addEventListener("seeked", done, { once: true });
      });
      if (!ready) {
        setError("This frame did not load. Seek again before annotating.");
        return;
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    if (!canvas.width || !canvas.height) {
      setError("Wait for the video to load before annotating.");
      return;
    }
    if (view()?.recording?.id !== recording.id || video.currentSrc !== source) {
      setError("The QA recording changed. Choose a frame from the current recording.");
      return;
    }
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    const timestampMs = Math.round(video.currentTime * 1000);
    const frame = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.88),
    );
    if (!frame) return;
    setCapture({
      id: crypto.randomUUID(),
      frame,
      context: { source: "recording", recordingId: recording.id, timestampMs },
      timestampMs,
      page: `QA ${recording.commitSha.slice(0, 8)}`,
    });
    setMarkingVideo(true);
    setComposing(false);
  }
  const open = () =>
    view()?.feedback.filter((item) => item.kind === "thread" && item.state !== "resolved").length ??
    0;
  const pendingThreads = () => pendingReviewThreads(view()?.feedback ?? []);
  const revisionAction = createMemo<ReviewRevisionAction | undefined>(() =>
    !props.compact && !readOnly() && pendingThreads().length
      ? {
          count: pendingThreads().length,
          disabled: busy() || Boolean(retry) || view()?.canSendCorrections === false,
          sending: busy() && retry?.action === "send",
          request: () => {
            void command("send", {
              commandId: crypto.randomUUID(),
              feedback: pendingThreads().map((item) => ({ id: item.id, version: item.version })),
            });
          },
        }
      : undefined,
  );
  const showComposer = () => composing() && !props.feedbackID && !readOnly();
  async function reloadReview() {
    setError("");
    setLoadFailed(false);
    await refresh().catch(() => setError("Review could not load. Reload review to retry."));
  }
  function addFeedback() {
    if (composing() && body().trim()) return;
    if (!body().trim()) {
      setCapture(undefined);
      setKind("comment");
    }
    setComposing(true);
    setComposerPosition({
      x: Math.max(12, (surface?.clientWidth ?? 340) - 326),
      y: 12,
    });
  }
  const actions = createMemo<ReviewActions | undefined>(() =>
    props.compact
      ? undefined
      : {
          revision: revisionAction(),
          addFeedback: readOnly() ? undefined : addFeedback,
          reload: () => void reloadReview(),
        },
  );
  createEffect(actions, (value) => {
    props.onActions?.(value);
  });
  onCleanup(() => props.onActions?.(undefined));
  const composer = () => (
    <ReviewComposer
      attachmentScopeKey={`feedback:${props.changeID}:new`}
      body={body()}
      kind={kind()}
      busy={busy()}
      locked={Boolean(retry) || !view()}
      source={
        capture()
          ? capture()!.context.source === "recording"
            ? `Video · ${reviewTime((capture()!.timestampMs ?? 0) / 1000, true)}`
            : (capture()!.element ?? capture()!.page)
          : undefined
      }
      image={frameURL() || undefined}
      reconstructed={capture()?.context.source === "preview"}
      onBody={setBody}
      onKind={setKind}
      active={props.active !== false && showComposer()}
      reveal={!props.compact && matchMedia("(max-width: 780px)").matches}
      onSubmit={(event) => void submit(event)}
      onDismiss={() => {
        setComposing(false);
        props.onClose?.();
      }}
      onCancel={() => {
        setCapture(undefined);
        setBody("");
        setComposing(false);
        setMarkingVideo(false);
        props.onCaptureCleared?.();
        props.onClose?.();
      }}
    />
  );
  const composerPlacement = () => (
    <div
      class={`review-composer-placement ${!props.compact ? "is-floating" : ""}`}
      style={
        !props.compact
          ? { left: `${composerPosition().x}px`, top: `${composerPosition().y}px` }
          : undefined
      }
    >
      {composer()}
    </div>
  );
  const feedbackRow = (item: () => ReviewFeedback) => (
    <FeedbackItem
      item={item()}
      mediaURL={mediaURL}
      readOnly={readOnly()}
      canResolve={props.canDevelop || props.userID === item().authorId}
      busy={busy() || Boolean(retry)}
      previous={Boolean(view()?.currentCommitSha && item().commitSha !== view()?.currentCommitSha)}
      pinLabel={String((view()?.feedback.findIndex((entry) => entry.id === item().id) ?? 0) + 1)}
      reply={replies()[item().id] ?? ""}
      onReply={(value) => setReplies((current) => ({ ...current, [item().id]: value }))}
      canSeek={(() => {
        const annotation = item().annotation;
        return (
          annotation?.source === "recording" &&
          annotation.recordingId === view()?.recording?.id &&
          view()?.recording?.state === "complete"
        );
      })()}
      onSeek={() => {
        const annotation = item().annotation;
        if (
          annotation?.source !== "recording" ||
          annotation.recordingId !== view()?.recording?.id ||
          !video
        )
          return;
        video.pause();
        seek(annotation.timestampMs / 1000);
        video.scrollIntoView({ block: "nearest" });
      }}
      onAction={(action, reply) =>
        command("update", {
          commandId: crypto.randomUUID(),
          feedbackId: item().id,
          expectedVersion: item().version,
          action,
          ...(reply ? { body: reply } : {}),
        })
      }
    />
  );
  return (
    <section
      ref={surface}
      class={`visual-review ${props.compact ? "compact" : ""}`}
      aria-label="Visual review"
    >
      <header class={`review-heading ${props.onActions ? "sr-only" : ""}`}>
        <div>
          <h3 class={!props.compact ? "sr-only" : ""}>
            {props.compact ? (props.feedbackID ? "Feedback" : "Comment on Preview") : "Review"}
          </h3>
          <Show when={!props.onThreadCount && view()}>
            <ReviewThreadStatus count={open()} />
          </Show>
        </div>
        <Show when={!props.compact}>
          <Show when={!props.onActions}>
            <TicketActionBar
              actions={[
                { id: "reload", label: "Reload review", run: () => void reloadReview() },
                ...(props.onOpenPreview
                  ? [{ id: "preview", label: "Open Live Preview", run: props.onOpenPreview }]
                  : []),
                ...(!readOnly()
                  ? [{ id: "feedback", label: "Add feedback", run: addFeedback }]
                  : []),
                ...(revisionAction()
                  ? [
                      {
                        id: "revision",
                        label: revisionAction()!.sending
                          ? "Requesting revision…"
                          : "Request revision",
                        disabled: revisionAction()!.disabled,
                        primary: true,
                        run: () => revisionAction()?.request(),
                      },
                    ]
                  : []),
              ]}
            />
          </Show>
        </Show>
      </header>
      <Show when={error()}>
        <p role="alert" class="review-error">
          {error()}{" "}
          <Show when={retry}>
            <button
              type="button"
              disabled={busy()}
              onClick={() => retry && void command(retry.action, retry.input)}
            >
              {retry?.action === "send" ? "Retry correction request" : "Retry save"}
            </button>
          </Show>
        </p>
      </Show>
      <Show when={notice()}>
        <p role="status">{notice()}</p>
      </Show>
      <Show
        when={view()}
        fallback={
          <Show when={loadFailed()} fallback={<p role="status">Loading review…</p>}>
            <p role="status">
              Review is unavailable.
              <Show when={props.compact}>
                {" "}
                <button type="button" class="quiet-button" onClick={() => void reloadReview()}>
                  Reload review
                </button>
              </Show>
            </p>
          </Show>
        }
      >
        <div class="review-layout">
          <Show when={!props.compact}>
            <div class="review-recording">
              <div
                class="review-player"
                ref={player}
                style={{ "--review-video-ratio": String(videoRatio()) }}
              >
                <div class={`review-recording-surface ${markingVideo() ? "is-marking" : ""}`}>
                  <Show
                    when={view()?.recording?.state === "complete"}
                    fallback={
                      <div class="review-video-empty">
                        <h4>QA recording</h4>
                        <p>
                          {view()?.recording?.state === "deleted"
                            ? "This QA video was removed. Original comment frames and feedback remain."
                            : ["recording", "intended"].includes(view()?.recording?.state ?? "")
                              ? "Recording the current QA flow. The video becomes available when capture finishes."
                              : (view()?.recording?.reason ?? "No complete QA recording yet.")}
                        </p>
                        <p>Video availability does not change the QA result.</p>
                      </div>
                    }
                  >
                    <video
                      ref={video}
                      preload="metadata"
                      playsinline
                      src={recordingSource()}
                      aria-label="QA recording"
                      tabindex="0"
                      onClick={togglePlayback}
                      onKeyDown={(event) => {
                        if (event.ctrlKey || event.metaKey || event.altKey) return;
                        if (event.key === " " || event.key.toLowerCase() === "k") {
                          event.preventDefault();
                          togglePlayback();
                        } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                          event.preventDefault();
                          seek(playhead() + (event.key === "ArrowRight" ? 5 : -5));
                        } else if (event.key.toLowerCase() === "f") {
                          event.preventDefault();
                          void toggleFullscreen();
                        }
                      }}
                      onPlay={() => setPaused(false)}
                      onPause={() => setPaused(true)}
                      onEnded={() => setPaused(true)}
                      onLoadedMetadata={syncMetadata}
                      onLoadedData={() => {
                        setVideoReady(true);
                        setVideoFailed(false);
                        syncMetadata();
                        setPlayhead(video?.currentTime ?? 0);
                        const id = view()?.recording?.id;
                        if (restoredRecording === id) return;
                        restoredRecording = id;
                        const retained = retainedReviewViews.get(viewKey());
                        if (
                          video &&
                          retained &&
                          retained.recordingID === view()?.recording?.id &&
                          Number.isFinite(video.duration) &&
                          Math.abs(video.currentTime - retained.time) > 0.05
                        )
                          video.currentTime = Math.min(retained.time, video.duration);
                      }}
                      onSeeked={syncPlayhead}
                      onError={() => {
                        setVideoReady(false);
                        setVideoFailed(true);
                      }}
                      onTimeUpdate={syncPlayhead}
                    >
                      <track
                        kind="captions"
                        src={captionsURL()}
                        srclang="en"
                        label="QA scenario descriptions"
                      />
                      Your browser cannot play this QA recording.
                    </video>
                  </Show>
                  <Show when={!markingVideo() && view()?.recording?.state === "complete"}>
                    <For each={view()?.feedback}>
                      {(item, index) => {
                        const point = () => {
                          const annotation = item.annotation;
                          return annotation?.source === "recording" &&
                            annotation.recordingId === view()?.recording?.id &&
                            Math.abs(annotation.timestampMs / 1000 - playhead()) <= 0.35
                            ? annotation.region
                            : undefined;
                        };
                        return (
                          <Show when={point()}>
                            {(region) => (
                              <button
                                type="button"
                                class="review-video-pin"
                                aria-label={`Open QA feedback ${index() + 1}`}
                                style={{
                                  left: `${region().x * 100}%`,
                                  top: `${region().y * 100}%`,
                                }}
                                onClick={() => focusFeedback(item)}
                              >
                                {index() + 1}
                              </button>
                            )}
                          </Show>
                        );
                      }}
                    </For>
                  </Show>
                  <Show when={view()?.recording?.state === "complete" && !readOnly()}>
                    <button
                      type="button"
                      class="review-comment-fab quiet-button"
                      disabled={!videoReady() || busy() || Boolean(retry)}
                      aria-pressed={markingVideo() ? "true" : "false"}
                      onClick={() => {
                        if (markingVideo()) setMarkingVideo(false);
                        else void annotateFrame();
                      }}
                    >
                      <Icon name="comment" />
                      {markingVideo() ? "Cancel selection" : "Comment"}
                    </button>
                  </Show>
                  <Show when={markingVideo()}>
                    <button
                      type="button"
                      class="review-video-selection"
                      aria-label="Choose a point on the paused QA frame"
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        const x =
                          event.detail === 0
                            ? 0.5
                            : Math.max(0, Math.min(0.999, (event.clientX - rect.x) / rect.width));
                        const y =
                          event.detail === 0
                            ? 0.5
                            : Math.max(0, Math.min(0.999, (event.clientY - rect.y) / rect.height));
                        setCapture((current) =>
                          current
                            ? { ...current, region: { x, y, width: 0.001, height: 0.001 } }
                            : current,
                        );
                        const outer = surface?.getBoundingClientRect();
                        setComposerPosition({
                          x: Math.max(
                            12,
                            Math.min(
                              (outer?.width ?? 340) - 326,
                              rect.x - (outer?.x ?? 0) + x * rect.width + 14,
                            ),
                          ),
                          y: Math.max(
                            12,
                            rect.y -
                              (outer?.y ?? 0) +
                              Math.min(y * rect.height, Math.max(12, rect.height - 280)),
                          ),
                        });
                        setMarkingVideo(false);
                        setComposing(true);
                      }}
                    >
                      <span>Click a point to add feedback. Enter selects the centre.</span>
                    </button>
                  </Show>
                </div>
                <Show when={view()?.recording?.state === "complete"}>
                  <ReviewPlayerControls
                    time={playhead()}
                    duration={duration()}
                    paused={paused()}
                    ready={duration() > 0 && !videoFailed()}
                    fullscreen={fullscreen()}
                    scenarios={view()!.scenarios}
                    feedback={view()!.feedback}
                    recordingID={view()!.recording!.id}
                    onPlay={togglePlayback}
                    onSeek={seek}
                    onFeedback={focusFeedback}
                    onFullscreen={() => void toggleFullscreen()}
                  />
                </Show>
              </div>
              <Show when={videoFailed()}>
                <p role="alert" class="review-error">
                  The QA video could not load. Saved frames and feedback remain available.{" "}
                  <button
                    type="button"
                    class="quiet-button"
                    onClick={() => {
                      setVideoFailed(false);
                      setVideoReady(false);
                      setDuration(0);
                      video?.load();
                    }}
                  >
                    Retry video
                  </button>
                </p>
              </Show>
              <Show when={showComposer() && capture()?.context.source === "recording"}>
                {composerPlacement()}
              </Show>
              <Show when={view()?.scenarios.length}>
                <div class="review-scenario-summary">
                  <fieldset class="review-scenarios">
                    <legend class="sr-only">QA scenarios</legend>
                    <For each={view()?.scenarios}>
                      {(scenario) => (
                        <button
                          type="button"
                          aria-pressed={selectedScenario() === scenario.id ? "true" : "false"}
                          onClick={() => {
                            if (
                              scenario.observationKind === "source" ||
                              scenario.hasRecordingPosition === false
                            )
                              video?.pause();
                            setSelectedScenario(scenario.id);
                            if (
                              video &&
                              view()?.recording?.state === "complete" &&
                              scenario.observationKind !== "source" &&
                              scenario.hasRecordingPosition !== false
                            ) {
                              seek(scenario.startedMs / 1000);
                            }
                          }}
                        >
                          <span
                            class={`review-scenario-status is-${scenario.status ?? "unfinished"}`}
                          >
                            <Show
                              when={scenario.status === "passed"}
                              fallback={<span aria-hidden="true">!</span>}
                            >
                              <Icon name="check" />
                            </Show>
                            <span class="sr-only">{scenario.status ?? "Unfinished"}: </span>
                          </span>
                          <span>{scenario.title}</span>
                          <Show when={scenario.observationKind === "source"}>
                            <small>Source check</small>
                          </Show>
                          <Show
                            when={
                              scenario.observationKind !== "source" &&
                              view()?.recording?.state === "complete" &&
                              scenario.hasRecordingPosition === false
                            }
                          >
                            <small>Timing unavailable</small>
                          </Show>
                        </button>
                      )}
                    </For>
                  </fieldset>
                  <For each={view()?.scenarios.filter((item) => item.id === selectedScenario())}>
                    {(scenario) => (
                      <dl class="review-scenario-outcome" aria-label={`${scenario.title} result`}>
                        <Show when={scenario.expected}>
                          <div>
                            <dt>Expected</dt>
                            <dd>{scenario.expected}</dd>
                          </div>
                        </Show>
                        <Show when={scenario.observed}>
                          <div>
                            <dt>Observed</dt>
                            <dd>{scenario.observed}</dd>
                          </div>
                        </Show>
                      </dl>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={view()?.recording?.state === "complete"}>
                <p class="review-recording-meta">
                  <Show when={view()?.recordingCurrent === false}>Earlier QA run. </Show>
                  Reviewed version <code>{view()?.recording?.commitSha.slice(0, 8)}</code>
                </p>
              </Show>
            </div>
          </Show>
          <div class="review-discussion">
            <Show
              when={!props.compact && showComposer() && capture()?.context.source !== "recording"}
            >
              {composerPlacement()}
            </Show>
            <div class="review-feedback-list">
              <Show
                when={visibleFeedback().length}
                fallback={
                  <p class="review-empty">
                    {props.compact
                      ? props.feedbackID
                        ? "This feedback is no longer available."
                        : ""
                      : "No feedback yet. Add general feedback or comment on the QA recording or Live Preview."}
                  </p>
                }
              >
                <For
                  each={visibleFeedback().filter(
                    (item) => item.kind === "thread" && item.state !== "resolved",
                  )}
                  keyed={(item) => item.id}
                >
                  {feedbackRow}
                </For>
                <For
                  each={visibleFeedback().filter((item) => item.kind === "comment")}
                  keyed={(item) => item.id}
                >
                  {feedbackRow}
                </For>
                <Show when={visibleFeedback().some((item) => item.state === "resolved")}>
                  <details class="review-resolved" open={props.compact}>
                    <summary>
                      Resolved (
                      {visibleFeedback().filter((item) => item.state === "resolved").length})
                    </summary>
                    <For
                      each={visibleFeedback().filter((item) => item.state === "resolved")}
                      keyed={(item) => item.id}
                    >
                      {feedbackRow}
                    </For>
                  </details>
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </Show>
      <Show when={props.compact && showComposer()}>{composerPlacement()}</Show>
    </section>
  );
}

function FeedbackItem(props: {
  item: ReviewFeedback;
  mediaURL(id: string): string;
  canResolve: boolean;
  readOnly: boolean;
  previous: boolean;
  pinLabel: string;
  reply: string;
  onReply(value: string): void;
  canSeek: boolean;
  onSeek(): void;
  busy: boolean;
  onAction(action: string, body?: string): Promise<boolean>;
}) {
  const [replying, setReplying] = createSignal(Boolean(props.reply));
  const [contextOpen, setContextOpen] = createSignal(false);
  const [thumbnailFailed, setThumbnailFailed] = createSignal(false);
  let replyInput: HTMLTextAreaElement | undefined;
  let source: HTMLDivElement | undefined;
  let sourceOpener: HTMLButtonElement | undefined;
  let contextPanel: HTMLDivElement | undefined;
  const contextID = `feedback-context-${crypto.randomUUID()}`;
  createEffect(contextOpen, (shown) => {
    if (!shown) return;
    const position = () => {
      if (!source || !contextPanel) return;
      let top = 8;
      let bottom = innerHeight - 8;
      for (let parent = source.parentElement; parent; parent = parent.parentElement) {
        if (!/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)) continue;
        const bounds = parent.getBoundingClientRect();
        top = Math.max(top, bounds.top + 8);
        bottom = Math.min(bottom, bounds.bottom - 8);
      }
      const anchor = source.getBoundingClientRect();
      const above = Math.max(0, anchor.top - top - 4);
      const below = Math.max(0, bottom - anchor.bottom - 4);
      const openAbove = below < Math.min(384, contextPanel.scrollHeight) && above > below;
      contextPanel.dataset["placement"] = openAbove ? "above" : "below";
      contextPanel.style.maxHeight = `${Math.min(384, openAbove ? above : below)}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    if (contextPanel) observer.observe(contextPanel);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    source?.addEventListener("load", position, true);
    const outside = (event: PointerEvent) => {
      if (!source?.contains(event.target as Node)) setContextOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    const dispose = contextPanel
      ? bindPopoverKeyboard(contextPanel, sourceOpener, () => setContextOpen(false))
      : undefined;
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      source?.removeEventListener("load", position, true);
      window.removeEventListener("pointerdown", outside);
      dispose?.();
    };
  });
  createEffect(
    () => props.reply,
    (value) => {
      if (value) setReplying(true);
    },
  );
  const representation = () => {
    const annotation = props.item.annotation;
    return annotation?.source === "preview" ? annotation.representation : undefined;
  };
  const timestamp = () => {
    const annotation = props.item.annotation;
    return annotation?.source === "recording" ? annotation.timestampMs : undefined;
  };
  const initials = (name: string) =>
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toLocaleUpperCase();
  const messageTime = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? ""
      : date.toLocaleString("en", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
  };
  const status = () => {
    if (props.item.state === "implemented") return "Ready to recheck";
    if (props.item.state === "resolved") return "Resolved";
    if (props.item.correctionState === "running") return "Revision in progress";
    if (props.item.correctionState === "sent") return "Revision sent";
    if (props.item.correctionState === "retry") return "Revision needs retry";
    return undefined;
  };
  return (
    <article
      id={`review-feedback-${props.item.id}`}
      class="review-feedback"
      tabindex="-1"
      aria-label={`${props.item.kind} by ${props.item.author}`}
    >
      <header class="review-message-heading">
        <span class="review-avatar" aria-hidden="true">
          {initials(props.item.author)}
        </span>
        <div class="review-message-byline">
          <strong>{props.item.author}</strong>
          <time
            datetime={props.item.createdAt}
            title={`${messageTime(props.item.createdAt)} · ${props.previous ? "Earlier source basis" : "Source basis"} ${props.item.commitSha.slice(0, 8)}`}
          >
            {messageTime(props.item.createdAt)}
          </time>
        </div>
        <Show when={props.item.kind === "thread" && status()}>
          <span class={`review-thread-state is-${props.item.state}`}>{status()}</span>
        </Show>
      </header>
      <div class="review-message-content">
        <Show when={props.item.annotation}>
          <div class="review-source" ref={source}>
            <Show when={props.canSeek}>
              <button
                type="button"
                class="review-text-action review-seek"
                onClick={() => {
                  setContextOpen(false);
                  props.onSeek();
                }}
              >
                <Icon name="play" />
                Video · {reviewTime((timestamp() ?? 0) / 1000, true)}
              </button>
            </Show>
            <button
              type="button"
              class="review-text-action review-context-trigger"
              ref={sourceOpener}
              aria-expanded={contextOpen() ? "true" : "false"}
              aria-controls={contextID}
              aria-haspopup="dialog"
              aria-label={props.canSeek ? "View saved QA frame" : undefined}
              title={
                representation() === "dom-reconstruction"
                  ? "Reconstructed element context"
                  : "Saved feedback context"
              }
              onClick={() => setContextOpen((shown) => !shown)}
            >
              <Show when={props.item.annotation?.mediaId && !thumbnailFailed()}>
                <img
                  class="review-context-thumbnail"
                  src={props.mediaURL(props.item.annotation!.mediaId!)}
                  alt=""
                  loading="lazy"
                  onError={() => setThumbnailFailed(true)}
                />
              </Show>
              <Show when={!props.canSeek} fallback={<span class="sr-only">Saved QA frame</span>}>
                {props.item.annotation?.source === "preview"
                  ? `Live Preview${props.item.annotation.element ? ` · ${props.item.annotation.element}` : ""}`
                  : `Video · ${reviewTime((timestamp() ?? 0) / 1000, true)}`}
              </Show>
              <Show when={props.canSeek && thumbnailFailed()}>
                <Icon name="preview" />
              </Show>
            </button>
            <Show when={contextOpen()}>
              <div
                class="review-source-popover"
                id={contextID}
                ref={contextPanel}
                role="dialog"
                aria-label="Saved feedback context"
              >
                <header class="review-context-heading">
                  <strong>
                    {representation() === "dom-reconstruction"
                      ? "Reconstructed element context"
                      : "Saved feedback context"}
                  </strong>
                  <button
                    type="button"
                    class="bare-icon"
                    aria-label="Close context"
                    onClick={() => {
                      setContextOpen(false);
                      sourceOpener?.focus();
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </header>
                <small>
                  {props.previous ? "Earlier source basis · " : "Source basis · "}
                  {props.item.commitSha.slice(0, 8)}
                </small>
                <Show when={props.item.annotation}>
                  {(annotation) => (
                    <>
                      <Show
                        when={annotation().mediaId}
                        fallback={
                          <p>No context image. The page and element anchor are retained.</p>
                        }
                      >
                        <div class="review-saved-frame-window">
                          <FrameRegion
                            image={props.mediaURL(annotation().mediaId!)}
                            region={
                              representation() === "dom-reconstruction"
                                ? undefined
                                : annotation().region
                            }
                            pinLabel={props.pinLabel}
                            reconstructed={representation() === "dom-reconstruction"}
                          />
                        </div>
                      </Show>
                      <small>{annotation().page}</small>
                      <Show when={annotation().source === "preview"}>
                        <p class="review-context-note">
                          Preview context, not clean-candidate proof.
                        </p>
                      </Show>
                      <Show when={representation() === "dom-reconstruction"}>
                        <p class="review-context-note">
                          DOM reconstruction. It can differ from the browser's pixels and is not a
                          replay of the current Preview.
                        </p>
                      </Show>
                    </>
                  )}
                </Show>
              </div>
            </Show>
          </div>
        </Show>
        <div
          class="review-message-body markdown-body"
          innerHTML={markdownHTML(props.item.messages[0]?.body ?? "")}
        />
        <Show when={props.item.messages.length > 1}>
          <div class="review-replies">
            <div class="review-reply-list">
              <For each={props.item.messages.slice(1)}>
                {(message) => (
                  <div class="review-message">
                    <header class="review-message-heading">
                      <span class="review-avatar" aria-hidden="true">
                        {initials(message.author)}
                      </span>
                      <div class="review-message-byline">
                        <strong>{message.author}</strong>
                        <time datetime={message.createdAt}>{messageTime(message.createdAt)}</time>
                      </div>
                    </header>
                    <div
                      class="review-message-body markdown-body"
                      innerHTML={markdownHTML(message.body)}
                    />
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
        <Show when={!props.readOnly}>
          <div class="review-feedback-actions">
            <button
              type="button"
              class="review-text-action"
              aria-expanded={replying() ? "true" : "false"}
              disabled={props.busy}
              onClick={() => {
                setReplying((value) => !value);
                if (replying()) queueMicrotask(() => replyInput?.focus());
              }}
            >
              Reply
            </button>
            <Show when={props.item.kind === "thread" && props.canResolve}>
              <button
                type="button"
                class="review-text-action"
                disabled={props.busy}
                onClick={() =>
                  void props.onAction(props.item.state === "resolved" ? "reopen" : "resolve")
                }
              >
                {props.item.state === "resolved" ? "Reopen Thread" : "Resolve Thread"}
              </button>
              <Show
                when={props.item.state === "implemented" || props.item.correctionState === "sent"}
              >
                <button
                  type="button"
                  class="review-text-action"
                  disabled={props.busy}
                  onClick={() => void props.onAction("reopen")}
                >
                  Needs changes
                </button>
              </Show>
            </Show>
          </div>
          <Show when={replying()}>
            <form
              class="review-reply-composer"
              onSubmit={async (event) => {
                event.preventDefault();
                const submitted = props.reply;
                if ((await props.onAction("reply", submitted)) && props.reply === submitted) {
                  props.onReply("");
                  setReplying(false);
                }
              }}
            >
              <TextareaAttachments
                disabled={props.busy}
                scopeKey={`feedback:${props.item.id}:reply`}
                privacy="feedback"
                content={props.reply}
              >
                <label>
                  Reply to {props.item.author}
                  <textarea
                    ref={replyInput}
                    value={attachmentText(props.reply)}
                    maxlength={2000}
                    onInput={(event) => props.onReply(readAttachmentContent(event.currentTarget))}
                  />
                </label>
              </TextareaAttachments>
              <button
                type="submit"
                class="quiet-button"
                disabled={props.busy || !props.reply.trim()}
              >
                Add reply
              </button>
            </form>
          </Show>
        </Show>
      </div>
    </article>
  );
}

function FrameRegion(props: {
  image: string;
  region?: z.infer<typeof reviewRegion> | undefined;
  pinLabel?: string;
  reconstructed?: boolean;
}) {
  const imageSource = createMemo(() => props.image);
  return (
    <div class={`review-frame ${props.reconstructed ? "is-reconstructed" : ""}`}>
      <img
        src={imageSource()}
        alt={
          props.reconstructed
            ? "DOM reconstruction of the selected element"
            : "Original review frame"
        }
        draggable={false}
      />
      <Show when={props.region}>
        {(region) => (
          <span
            class={`review-region ${region().width < 0.01 && region().height < 0.01 ? "is-point" : ""}`}
            style={{
              left: `${region().x * 100}%`,
              top: `${region().y * 100}%`,
              width: `${region().width * 100}%`,
              height: `${region().height * 100}%`,
            }}
          />
        )}
      </Show>
      <Show when={props.pinLabel}>
        <span
          class="review-author-pin"
          style={{
            left: `${Math.min(70, (props.region?.x ?? 0.02) * 100)}%`,
            top: `${Math.min(90, (props.region?.y ?? 0.02) * 100)}%`,
          }}
        >
          {props.pinLabel}
        </span>
      </Show>
    </div>
  );
}
