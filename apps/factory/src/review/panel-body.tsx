import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { ReviewFeedback, VisualReview } from "#conversation-domain/visual-review";
import { executeReviewCommand, type PanelCommandContext } from "./panel-commands";
import * as machine from "./panel-machine";
import { ReviewFeedbackList } from "./panel-sections";
import { calculateComposerPosition, type PanelReviewCapture } from "./panel-state";
import { RecordingStage, type RecordingStageHandle } from "./recording-stage";

export type ReviewPanelBodyState = {
  loadState: machine.ReviewLoadState;
  commandState: machine.ReviewCommandState;
  composerPhase: machine.ComposerPhase;
  draft: machine.ReviewDraftState;
  selectedScenario: string;
  resolvedOpen: boolean;
  showComposer: boolean;
  visibleFeedback: ReviewFeedback[];
};

export function ReviewPanelBody(props: {
  state: ReviewPanelBodyState;
  compact: boolean;
  hasExternalActions: boolean;
  viewKey: string;
  active?: boolean | undefined;
  readOnly: boolean;
  feedbackID: string | undefined;
  userID: string;
  canDevelop: boolean;
  mediaURL(id: string): string;
  surfaceRect(): DOMRect | undefined;
  composer(): JSX.Element;
  onReload(): void;
  setComposerPhase(updater: (prev: machine.ComposerPhase) => machine.ComposerPhase): void;
  onSelectedScenario(id: string): void;
  onFocusFeedback(item: ReviewFeedback): void;
  onError(message: string): void;
  onStageReady(handle: RecordingStageHandle): void;
  onResolvedOpen(open: boolean): void;
  setDraft(updater: (prev: machine.ReviewDraftState) => machine.ReviewDraftState): void;
  onSeek(item: ReviewFeedback, view: VisualReview): void;
  commandContext: PanelCommandContext;
}) {
  const view = () => machine.reviewViewOf(props.state.loadState);
  return (
    <Show
      when={view()}
      fallback={
        <Show
          when={props.state.loadState.kind === "failed"}
          fallback={<p role="status">Loading review… Feedback is available once it loads.</p>}
        >
          <p role="status">
            Review is unavailable. Reload review before adding feedback.
            <Show when={props.compact || props.hasExternalActions}>
              {" "}
              <button type="button" class="quiet-button" onClick={props.onReload}>
                Reload review
              </button>
            </Show>
          </p>
        </Show>
      }
    >
      {(currentView) => (
        <div class="review-layout">
          <Show when={!props.compact}>
            <RecordingStage
              view={currentView()}
              viewKey={props.viewKey}
              mediaURL={props.mediaURL}
              active={props.active}
              readOnly={props.readOnly}
              locked={machine.isCommandLocked(props.state.commandState)}
              hasDraftBody={Boolean(props.state.draft.body.trim())}
              markingVideo={props.state.composerPhase.kind === "marking"}
              selectedScenario={props.state.selectedScenario}
              showRecordingComposer={
                props.state.showComposer &&
                props.state.composerPhase.capture?.context.source === "recording"
              }
              composer={props.composer()}
              onCancelMarking={() => props.setComposerPhase(machine.cancelVideoMarking)}
              onSelectedScenario={props.onSelectedScenario}
              onOpenComposer={() => props.setComposerPhase(machine.openComposerKeepingPosition)}
              onCapturedFrame={(captured: PanelReviewCapture) =>
                props.setComposerPhase((prev) => machine.startVideoMarking(prev, captured))
              }
              onSelectFramePoint={(x, y, rect) =>
                props.setComposerPhase((prev) =>
                  machine.selectVideoFramePoint(
                    prev,
                    x,
                    y,
                    calculateComposerPosition(props.surfaceRect(), rect, x, y),
                  ),
                )
              }
              onFocusFeedback={props.onFocusFeedback}
              onError={props.onError}
              onStageReady={props.onStageReady}
            />
          </Show>
          <div class="review-discussion">
            <Show
              when={
                !props.compact &&
                props.state.showComposer &&
                props.state.composerPhase.capture?.context.source !== "recording"
              }
            >
              {props.composer()}
            </Show>
            <ReviewFeedbackList
              view={currentView()}
              visibleFeedback={props.state.visibleFeedback}
              compact={props.compact}
              feedbackID={props.feedbackID}
              userID={props.userID}
              canDevelop={props.canDevelop}
              readOnly={props.readOnly}
              commandState={props.state.commandState}
              replies={props.state.draft.replies}
              resolvedOpen={props.state.resolvedOpen}
              mediaURL={props.mediaURL}
              onResolvedOpen={props.onResolvedOpen}
              onReply={(id, value) =>
                props.setDraft((prev) => ({ ...prev, replies: { ...prev.replies, [id]: value } }))
              }
              onSeek={(item) => props.onSeek(item, currentView())}
              onAction={(item, action, reply) =>
                executeReviewCommand(props.commandContext, "update", {
                  commandId: crypto.randomUUID(),
                  feedbackId: item.id,
                  expectedVersion: item.version,
                  action,
                  ...(reply ? { body: reply } : {}),
                })
              }
            />
          </div>
        </div>
      )}
    </Show>
  );
}
