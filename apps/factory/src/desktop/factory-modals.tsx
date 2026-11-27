import { Show } from "solid-js";
import { plainErrorMessage } from "../command-error";
import { unavailableLink } from "../navigation/desktop";
import { PlanningSyncStatus } from "../zero/sync-status";

type SyncQueries = Parameters<typeof PlanningSyncStatus>[0]["queries"];

export function DesktopMenuBackdrop(props: { open: () => boolean; onClose: () => void }) {
  return (
    <Show when={props.open()}>
      <button
        type="button"
        class="popover-backdrop"
        aria-label="Close menu"
        tabindex={-1}
        onClick={() => props.onClose()}
      />
    </Show>
  );
}

export function DesktopNotices(props: {
  onNoticesRef: (element: HTMLDivElement) => void;
  pendingNavigation: () => boolean;
  navigationFailure: () => string | undefined;
  onRetryNavigation: () => void;
  error: () => string;
  syncQueries: () => SyncQueries;
  syncError: () => string;
  onRetrySync: () => Promise<void>;
}) {
  return (
    <div class="desktop-notices" ref={(element) => props.onNoticesRef(element)}>
      <Show when={props.pendingNavigation()}>
        <div class="sync-notice" role="status" data-transient>
          <span>Opening linked view…</span>
        </div>
      </Show>
      <Show when={props.navigationFailure()}>
        <div class="sync-notice" role="alert">
          <span>{props.navigationFailure() || unavailableLink}</span>
          <button type="button" class="quiet-button" onClick={() => props.onRetryNavigation()}>
            Retry link
          </button>
        </div>
      </Show>
      <Show when={props.error()}>
        <p class="error-toast" role="alert">
          {plainErrorMessage(props.error())}
        </p>
      </Show>
      <PlanningSyncStatus
        queries={props.syncQueries()}
        readError={props.syncError()}
        onRetry={props.onRetrySync}
      />
    </div>
  );
}

export function AgentOverlayBackdrop(props: { visible: () => boolean; onDismiss: () => void }) {
  return (
    <Show when={props.visible()}>
      <button
        type="button"
        class="agent-overlay-backdrop"
        aria-label="Dismiss Agent overlay"
        tabindex={-1}
        onClick={() => props.onDismiss()}
      />
    </Show>
  );
}
