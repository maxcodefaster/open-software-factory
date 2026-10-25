import { lazy, Loading } from "solid-js";
import type { RichDocumentSurfaceProps } from "./rich-document-editor";

export type { RichDocumentSurfaceProps } from "./rich-document-editor";

const Editor = lazy(() => import("./rich-document-editor"));

export function RichDocumentSurface(props: RichDocumentSurfaceProps) {
  return (
    <Loading fallback={<p role="status">Loading editor…</p>}>
      <Editor {...props} />
    </Loading>
  );
}
