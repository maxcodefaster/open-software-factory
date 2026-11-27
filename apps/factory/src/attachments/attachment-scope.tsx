import type { JSX } from "@solidjs/web";
import { createContext, createSignal, onCleanup, useContext } from "solid-js";
import { createUploadDraftRegistry, type UploadDraftRegistry } from "./upload-state";

export type AttachmentScopeValue = {
  projectId(): string | undefined;
  identity(): string;
  pending(): boolean;
  begin(): () => void;
  drafts: UploadDraftRegistry;
};

const AttachmentScope = createContext<AttachmentScopeValue>();

export function AttachmentProvider(props: {
  projectId: string | undefined;
  scopeKey?: string;
  children: JSX.Element;
}) {
  const [uploads, setUploads] = createSignal(0);
  const drafts = createUploadDraftRegistry();
  let alive = true;
  onCleanup(() => {
    alive = false;
  });
  return (
    <AttachmentScope
      value={{
        projectId: () => props.projectId,
        identity: () => props.scopeKey ?? props.projectId ?? "",
        pending: () => uploads() > 0,
        drafts,
        begin: () => {
          setUploads((value) => value + 1);
          return () => {
            if (alive) setUploads((value) => value - 1);
          };
        },
      }}
    >
      {props.children}
    </AttachmentScope>
  );
}

export function useOptionalAttachmentScope(): AttachmentScopeValue | undefined {
  try {
    return useContext(AttachmentScope);
  } catch {
    return undefined;
  }
}

export function useAttachmentPending() {
  try {
    return useContext(AttachmentScope).pending;
  } catch {
    return () => false;
  }
}

export function useAttachmentProject() {
  // Standalone read-only renderers and isolated editor fixtures need no upload scope.
  try {
    return useContext(AttachmentScope).projectId;
  } catch {
    return () => undefined;
  }
}
