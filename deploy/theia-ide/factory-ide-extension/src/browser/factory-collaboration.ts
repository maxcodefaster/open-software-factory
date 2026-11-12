import type { FrontendApplicationContribution } from "@theia/core/lib/browser/frontend-application-contribution";
import { StatusBar, StatusBarAlignment } from "@theia/core/lib/browser/status-bar/status-bar";
import { inject, injectable } from "@theia/core/shared/inversify";
import { CommandRegistry } from "@theia/core/lib/common/command";
import { EditorManager } from "@theia/editor/lib/browser/editor-manager";
import type { EditorWidget } from "@theia/editor/lib/browser/editor-widget";
import { MonacoEditor } from "@theia/monaco/lib/browser/monaco-editor";
import type * as monaco from "@theia/monaco-editor-core";
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { sharedEditorDocuments } from "./factory-collaboration-registry";
import { workspaceResource, workspaceScheme } from "./factory-workspace-files";

const base64 = (bytes: Uint8Array) => {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768)
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(parts.join(""));
};
const bytes = (text: string) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
type Peer = {
  clientID: number;
  participantID: string;
  name: string;
  color: string;
  cursor: { anchor: string; head: string } | null;
};
type Observation = {
  update: string;
  vector: string;
  revision: string;
  dirty: boolean;
  conflict: boolean;
  canWrite: boolean;
  participants: Peer[];
};

@injectable()
export class FactoryCollaboration implements FrontendApplicationContribution {
  @inject(CommandRegistry) private readonly commands!: CommandRegistry;
  private resolveActive: (() => Promise<void>) | undefined;
  @inject(EditorManager) private readonly editors!: EditorManager;
  @inject(StatusBar) private readonly status!: StatusBar;
  private readonly rooms = new Map<
    string,
    {
      add(editor: monaco.editor.IStandaloneCodeEditor): void;
      remove(editor: monaco.editor.IStandaloneCodeEditor): void;
      close(): void;
    }
  >();
  private readonly observed = new WeakSet<EditorWidget>();
  onDidInitializeLayout() {
    this.commands.registerCommand(
      { id: "factory.resolveSharedConflict", label: "Compare and resolve shared file conflict" },
      { isEnabled: () => Boolean(this.resolveActive), execute: () => this.resolveActive?.() },
    );
    for (const editor of this.editors.all) this.observe(editor);
    this.editors.onCreated((editor) => this.observe(editor));
  }
  private observe(widget: EditorWidget) {
    if (widget.editor.uri.scheme !== workspaceScheme || !(widget.editor instanceof MonacoEditor))
      return;
    if (this.observed.has(widget)) return;
    this.observed.add(widget);
    const editor = widget.editor.getControl();
    const model = editor.getModel();
    if (!model) {
      // Theia creates the widget before Monaco attaches its asynchronously loaded document.
      const changed = editor.onDidChangeModel(() => {
        if (!editor.getModel()) return;
        changed.dispose();
        disposed.dispose();
        this.observed.delete(widget);
        this.observe(widget);
      });
      const disposed = widget.onDispose(() => changed.dispose());
      return;
    }
    const key = widget.editor.uri.toString();
    const existing = this.rooms.get(key);
    if (existing) {
      existing.add(editor);
      widget.onDispose(() => existing.remove(editor));
      return;
    }
    const identity = workspaceResource(widget.editor.uri);
    const editors = new Set<monaco.editor.IStandaloneCodeEditor>([editor]);
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const remote = new Map<number, Awareness>();
    const participantID = crypto.randomUUID();
    const style = document.createElement("style");
    document.head.append(style);
    let original = model.getValue();
    let active = true,
      started = false,
      canWrite = false,
      binding: MonacoBinding | undefined;
    let serverVector: Uint8Array | undefined,
      revision = "",
      timer: ReturnType<typeof setTimeout> | undefined;
    let localUpdates = 0,
      acknowledgedUpdates = 0;
    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin !== "factory") localUpdates++;
    });
    let syncing: Promise<void> | undefined;
    const url = (action: string) =>
      new URL(
        `__factory/workspaces/${identity.workspaceID}/collaboration/${action}`,
        new URL("./", window.location.href),
      );
    const request = async (action: string, input: unknown) => {
      const response = await fetch(url(action), {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15000),
      });
      const value = await response.json();
      if (!response.ok)
        throw Object.assign(
          new Error(
            typeof value.error === "string"
              ? value.error
              : "Shared editing is unavailable. Your local buffer is retained.",
          ),
          { status: response.status },
        );
      return value;
    };
    const show = (text: string) => {
      if (this.editors.currentEditor?.editor.uri.toString() !== key) return;
      void this.status.setElement("factory-collaboration", {
        text,
        tooltip: text,
        alignment: StatusBarAlignment.LEFT,
        priority: 96,
        ...(this.resolveActive ? { command: "factory.resolveSharedConflict" } : {}),
      });
    };
    const resolveDialog = async () => {
      const observed = (await request("read", { path: identity.path })) as {
        content: string;
        savedContent: string;
        revision: string;
        diskVersion: string;
        diskMissing?: boolean;
      };
      const dialog = document.createElement("dialog");
      dialog.className = "factory-writer-status factory-shared-conflict";
      dialog.setAttribute("aria-label", "Compare shared and saved source");
      const heading = document.createElement("h2");
      heading.textContent = "Saved source changed outside shared editing";
      const description = document.createElement("p");
      description.textContent =
        "Compare both versions. Keeping the shared buffer lets you save it deliberately afterwards. Using saved source replaces the shared buffer for every participant.";
      const compare = document.createElement("div");
      compare.className = "factory-shared-compare";
      for (const [name, content] of [
        ["Shared unsaved buffer", observed.content],
        [
          observed.diskMissing ? "Saved file was deleted" : "Current saved source",
          observed.savedContent,
        ],
      ]) {
        const label = document.createElement("label"),
          text = document.createElement("textarea");
        label.textContent = name ?? "";
        text.readOnly = true;
        text.value = content ?? "";
        text.setAttribute("aria-label", name ?? "");
        label.append(text);
        compare.append(label);
      }
      const failure = document.createElement("p");
      failure.setAttribute("role", "alert");
      const actions = document.createElement("div");
      actions.className = "factory-writer-actions";
      for (const [choice, label] of [
        ["keep-shared", "Keep shared buffer"],
        ["use-saved", "Use saved source"],
        ["cancel", "Cancel"],
      ] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "theia-button secondary";
        button.textContent = label;
        actions.append(button);
        button.onclick = () => {
          if (choice === "cancel") {
            dialog.close();
            return;
          }
          for (const target of actions.querySelectorAll("button")) target.disabled = true;
          void request("resolve", {
            requestID: crypto.randomUUID(),
            path: identity.path,
            revision: observed.revision,
            diskVersion: observed.diskVersion,
            choice,
          })
            .then(() => {
              dialog.close();
              return sync();
            })
            .catch((error) => {
              failure.textContent =
                error instanceof Error ? error.message : "Resolution was not confirmed";
              for (const target of actions.querySelectorAll("button")) target.disabled = false;
            });
        };
      }
      dialog.append(heading, description, compare, failure, actions);
      document.body.append(dialog);
      dialog.addEventListener(
        "close",
        () => {
          dialog.remove();
          editor.focus();
        },
        { once: true },
      );
      dialog.showModal();
    };
    const reconcilePeers = (peers: Peer[]) => {
      const seen = new Set(peers.map((peer) => peer.clientID));
      for (const [id, peer] of remote)
        if (!seen.has(id)) {
          removeAwarenessStates(awareness, [id], "factory");
          peer.destroy();
          peer.doc.destroy();
          remote.delete(id);
        }
      const rules: string[] = [];
      for (const peer of peers) {
        if (!Number.isInteger(peer.clientID) || !/^#[0-9a-f]{6}$/i.test(peer.color)) continue;
        const selection = peer.cursor
          ? {
              anchor: Y.decodeRelativePosition(bytes(peer.cursor.anchor)),
              head: Y.decodeRelativePosition(bytes(peer.cursor.head)),
            }
          : undefined;
        const state = {
          user: { name: peer.name, color: peer.color },
          ...(selection ? { selection } : {}),
        };
        if (peer.clientID === doc.clientID) {
          if (!awareness.getLocalState()?.user) awareness.setLocalStateField("user", state.user);
        } else {
          let other = remote.get(peer.clientID);
          if (!other) {
            const document = new Y.Doc();
            document.clientID = peer.clientID;
            other = new Awareness(document);
            const previous = awareness.meta.get(peer.clientID);
            if (previous) other.meta.set(peer.clientID, { ...previous, lastUpdated: Date.now() });
            remote.set(peer.clientID, other);
          }
          other.setLocalState(state);
          applyAwarenessUpdate(awareness, encodeAwarenessUpdate(other, [peer.clientID]), "factory");
          rules.push(
            `.yRemoteSelection-${peer.clientID}{background-color:${peer.color}33}.yRemoteSelectionHead-${peer.clientID}{border-left:2px solid ${peer.color}}.yRemoteSelectionHead-${peer.clientID}::after{content:${JSON.stringify(peer.name)};position:absolute;top:-1.3em;left:-2px;background:${peer.color};color:white;padding:1px 4px;white-space:nowrap;font-size:11px;line-height:1.2}`,
          );
        }
      }
      style.textContent = rules.join("\n");
    };
    const sync = async () => {
      if (!active) return;
      if (syncing) return syncing;
      syncing = (async () => {
        if (!started) {
          if (widget.editor.document.dirty) {
            show("Save your local draft before joining shared editing. It has not been replaced.");
            return;
          }
          original = model.getValue();
          for (const target of editors) target.updateOptions({ readOnly: true });
        }
        const local = awareness.getLocalState()?.selection as
          | { anchor: Y.RelativePosition; head: Y.RelativePosition }
          | undefined;
        const sentUpdates = localUpdates;
        const update =
          started && canWrite && serverVector && localUpdates > acknowledgedUpdates
            ? Y.encodeStateAsUpdate(doc, serverVector)
            : undefined;
        const result = (await request("sync", {
          path: identity.path,
          participantID,
          clientID: doc.clientID,
          vector: base64(Y.encodeStateVector(doc)),
          ...(update && update.length > 2 ? { update: base64(update) } : {}),
          cursor: local
            ? {
                anchor: base64(Y.encodeRelativePosition(local.anchor)),
                head: base64(Y.encodeRelativePosition(local.head)),
              }
            : null,
        })) as Observation;
        if (!active) return;
        if (
          typeof result.update !== "string" ||
          typeof result.vector !== "string" ||
          typeof result.revision !== "string" ||
          !Array.isArray(result.participants)
        )
          throw new Error("Invalid shared editing observation");
        Y.applyUpdate(doc, bytes(result.update), "factory");
        serverVector = bytes(result.vector);
        revision = result.revision;
        canWrite = result.canWrite;
        if (update) acknowledgedUpdates = sentUpdates;
        if (!started) {
          if (model.getValue() !== original)
            throw new Error(
              "Local edits arrived before shared editing connected. They are retained; reopen after saving a copy.",
            );
          binding = new MonacoBinding(doc.getText("text"), model, editors, awareness);
          started = true;
          sharedEditorDocuments.set(key, {
            save: async () => {
              await sync();
              while (active && canWrite && localUpdates > acknowledgedUpdates) await sync();
              // Save only the revision observed after all current local edits were uploaded.
              const result = await request("save", { path: identity.path, revision });
              await sync();
              return result;
            },
          });
        }
        for (const target of editors) target.updateOptions({ readOnly: !canWrite });
        reconcilePeers(result.participants);
        if (this.editors.currentEditor?.editor.uri.toString() === key)
          this.resolveActive = result.conflict && canWrite ? resolveDialog : undefined;
        show(
          result.conflict
            ? "Shared buffer retained · disk conflict"
            : `${result.participants.map((peer) => peer.name).join(", ")} · ${result.dirty ? "shared unsaved edits" : "shared saved source"}`,
        );
      })();
      try {
        await syncing;
      } finally {
        syncing = undefined;
      }
    };
    const poll = async () => {
      if (!active) return;
      try {
        await sync();
      } catch (cause) {
        const error = cause as Error & { status?: number };
        if (this.editors.currentEditor?.editor.uri.toString() === key)
          this.resolveActive = undefined;
        for (const target of editors) target.updateOptions({ readOnly: true });
        show(error.message);
        // A non-shared Workspace continues to use the normal source provider.
        if (!started && error.status === 409) {
          for (const target of editors) target.updateOptions({ readOnly: false });
          void this.status.removeElement("factory-collaboration");
          timer = setTimeout(() => void poll(), 2000);
          return;
        }
        if ([401, 403, 404].includes(error.status ?? 0)) {
          active = false;
          return;
        }
      }
      if (active) timer = setTimeout(() => void poll(), 250);
    };
    const room = {
      add: (target: monaco.editor.IStandaloneCodeEditor) => {
        editors.add(target);
        if (started) {
          binding?.destroy();
          binding = new MonacoBinding(doc.getText("text"), model, editors, awareness);
        }
        target.updateOptions({ readOnly: !canWrite });
      },
      remove: (target: monaco.editor.IStandaloneCodeEditor) => {
        editors.delete(target);
        if (!editors.size) room.close();
        else if (started) {
          binding?.destroy();
          binding = new MonacoBinding(doc.getText("text"), model, editors, awareness);
        }
      },
      close: () => {
        if (this.rooms.size === 1 || this.editors.currentEditor?.editor.uri.toString() === key) {
          this.resolveActive = undefined;
          void this.status.removeElement("factory-collaboration");
        }
        active = false;
        clearTimeout(timer);
        binding?.destroy();
        awareness.destroy();
        doc.destroy();
        for (const peer of remote.values()) {
          peer.destroy();
          peer.doc.destroy();
        }
        remote.clear();
        style.remove();
        sharedEditorDocuments.delete(key);
        this.rooms.delete(key);
      },
    };
    this.rooms.set(key, room);
    editor.updateOptions({ readOnly: true });
    widget.onDispose(() => room.remove(editor));
    void poll();
  }
  onStop() {
    for (const room of [...this.rooms.values()]) room.close();
  }
}
